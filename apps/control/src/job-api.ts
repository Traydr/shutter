import { createHash, timingSafeEqual } from "node:crypto";
import {
  buildMasterPreviewKey,
  CONTROL_HTTP_ROUTES,
  type ExecutorCompleteRequest,
  type ExecutorFailRequest,
  type ExecutorHeartbeatRequest,
  operationalEvent,
  ProtocolError,
  parseExecutorCompleteRequest,
  parseExecutorFailRequest,
  parseExecutorHeartbeatRequest,
  parsePreviewJobSubmission,
  type RenditionJobRepresentation,
  type RenditionKind,
  verifySourceCapability,
} from "@shutter/protocol";
import { Hono } from "hono";
import { type ControlLogger, operationalErrorType } from "./logging.js";
import type {
  JobIdentity,
  MasterCompletion,
  RenditionJobLifecycle,
} from "./rendition-job-lifecycle.js";
import type { SourcePurge } from "./source-purge.js";
import type { ActiveSpaceAuthorization, SpaceRegistry } from "./spaces/registry.js";

export interface JobApiRuntime {
  logger: ControlLogger;
  lifecycle: RenditionJobLifecycle;
  now(): Date;
  spaceRegistry: SpaceRegistry;
  executorToken(kind: RenditionKind): string | undefined;
  dispatch(kind: RenditionKind): Promise<void>;
  sourcePurge?: SourcePurge;
}

function digest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

function bearer(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function tokenMatches(actual: string | undefined, expected: readonly string[]): boolean {
  if (actual === undefined || actual.length < 32) return false;
  return expected.some((candidate) => {
    if (candidate.length < 32) return false;
    return timingSafeEqual(digest(actual), digest(candidate));
  });
}

function kind(value: string): RenditionKind | undefined {
  return value === "video" || value === "pdf" ? value : undefined;
}

function identityFromRoute(context: {
  req: { param(name: string): string };
}): JobIdentity | undefined {
  const parsedKind = kind(context.req.param("kind"));
  if (parsedKind === undefined) return undefined;
  return {
    spaceId: context.req.param("spaceId"),
    sourceId: context.req.param("sourceId"),
    kind: parsedKind,
  };
}

/**
 * The Space authorization ladder for application-facing routes: 404 only after
 * a successful query confirms no active Space, 401 for a bad or missing API
 * token, 503 when the registry itself failed. One resolved registry call per
 * request; every route consumes the same closed union.
 */
async function spaceAccess(
  runtime: JobApiRuntime,
  spaceId: string,
  authorizationHeader: string | undefined,
): Promise<{ response: Response } | { authorization: ActiveSpaceAuthorization }> {
  try {
    const result = await runtime.spaceRegistry.authorizeSpaceRequest(
      spaceId,
      bearer(authorizationHeader),
    );
    switch (result.outcome) {
      case "missing":
        return { response: requestFailure(404, "not_found") };
      case "unauthorized":
        return { response: requestFailure(401, "unauthorized") };
      case "authorized":
        return { authorization: { policy: result.policy, capabilityKeys: result.capabilityKeys } };
    }
  } catch {
    return { response: requestFailure(503, "service_unavailable") };
  }
}

function activeResponse(body: RenditionJobRepresentation, location: string): Response {
  const active = body.status === "pending" || body.status === "processing";
  return Response.json(body, {
    status: active ? 202 : 200,
    ...(active ? { headers: { location, "retry-after": "5" } } : {}),
  });
}

function requestFailure(status: number, code: string): Response {
  return Response.json(
    { error: { code } },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}

async function strictJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ProtocolError("submission_invalid", "request must use application/json");
  }
  return request.json();
}

export function createJobApi(runtime: JobApiRuntime): Hono {
  const api = new Hono();

  api.post(CONTROL_HTTP_ROUTES.sourcePurge, async (context) => {
    const spaceId = context.req.param("spaceId");
    const sourceId = context.req.param("sourceId");
    const access = await spaceAccess(runtime, spaceId, context.req.header("authorization"));
    if ("response" in access) return access.response;
    const sourcePurge = runtime.sourcePurge;
    if (sourcePurge === undefined) return requestFailure(503, "service_unavailable");
    try {
      await sourcePurge.purge({ spaceId, sourceId });
      return new Response(null, { status: 204 });
    } catch {
      return requestFailure(503, "service_unavailable");
    }
  });

  api.put(CONTROL_HTTP_ROUTES.previewJob, async (context) => {
    const identity = identityFromRoute(context);
    if (identity === undefined) return requestFailure(404, "not_found");
    const access = await spaceAccess(
      runtime,
      identity.spaceId,
      context.req.header("authorization"),
    );
    if ("response" in access) return access.response;
    const authorization = access.authorization;
    try {
      const submission = parsePreviewJobSubmission(await strictJson(context.req.raw));
      const now = runtime.now();
      const claims = await verifySourceCapability(submission.sourceCapability, {
        spaceId: identity.spaceId,
        expectedPurpose: "preview_job",
        expectedSourceId: identity.sourceId,
        expectedKind: identity.kind,
        keys: authorization.capabilityKeys,
        now: Math.floor(now.getTime() / 1_000),
        allowedSourceOrigins: authorization.policy.allowedSourceOrigins,
      });
      const submissionResult = await runtime.lifecycle.submit(
        {
          ...identity,
          sourceCapability: submission.sourceCapability,
          capabilityExpiresAt: new Date(claims.exp * 1_000),
        },
        now,
      );
      const record = submissionResult.job;
      runtime.logger.emit(
        "info",
        await operationalEvent({
          event: "control.job.submitted",
          spaceId: record.spaceId,
          sourceId: record.sourceId,
          fields: {
            kind: record.kind,
            executionCycle: record.executionCycle,
            attemptNumber: record.attemptNumber,
            outcome: "accepted",
          },
        }),
      );
      if (record.status === "pending") {
        void runtime.dispatch(record.kind).catch(() => {
          void operationalEvent({
            event: "control.dispatch.failed",
            spaceId: record.spaceId,
            sourceId: record.sourceId,
            fields: { kind: record.kind, outcome: "failed", failureCode: "service_unavailable" },
          }).then((event) => runtime.logger.emit("error", event));
        });
      }
      return activeResponse(record.representation, new URL(context.req.url).pathname);
    } catch (error) {
      if (error instanceof ProtocolError) return requestFailure(400, error.code);
      runtime.logger.emit("error", {
        event: "control.service.failed",
        outcome: "failed",
        failureCode: "service_unavailable",
        errorType: operationalErrorType(error),
      });
      return requestFailure(503, "service_unavailable");
    }
  });

  api.get(CONTROL_HTTP_ROUTES.previewJob, async (context) => {
    const identity = identityFromRoute(context);
    if (identity === undefined) return requestFailure(404, "not_found");
    const access = await spaceAccess(
      runtime,
      identity.spaceId,
      context.req.header("authorization"),
    );
    if ("response" in access) return access.response;
    const record = await runtime.lifecycle.read(identity);
    if (record === undefined) return requestFailure(404, "not_found");
    return activeResponse(record.representation, new URL(context.req.url).pathname);
  });

  api.post(CONTROL_HTTP_ROUTES.executorClaim, async (context) => {
    const parsedKind = kind(context.req.param("kind"));
    if (
      parsedKind === undefined ||
      !tokenMatches(bearer(context.req.header("authorization")), [
        runtime.executorToken(parsedKind) ?? "",
      ])
    ) {
      return requestFailure(401, "unauthorized");
    }
    const now = runtime.now();
    const claim = await runtime.lifecycle.claim(parsedKind, now);
    if (claim === undefined) return new Response(null, { status: 204 });
    let authorization: ActiveSpaceAuthorization | undefined;
    try {
      authorization = await runtime.spaceRegistry.getSpaceAuthorization(claim.spaceId);
    } catch {
      return requestFailure(503, "service_unavailable");
    }
    if (authorization === undefined) {
      await runtime.lifecycle.fail(
        claim,
        claim.processingToken,
        { retryable: false, code: "configuration_error" },
        now,
      );
      return requestFailure(503, "configuration_error");
    }
    try {
      const claims = await verifySourceCapability(claim.sourceCapability, {
        spaceId: claim.spaceId,
        expectedPurpose: "preview_job",
        expectedSourceId: claim.sourceId,
        expectedKind: claim.kind,
        keys: authorization.capabilityKeys,
        now: Math.floor(now.getTime() / 1_000),
        allowedSourceOrigins: authorization.policy.allowedSourceOrigins,
      });
      return context.json({
        spaceId: claim.spaceId,
        sourceId: claim.sourceId,
        kind: claim.kind,
        locator: claims.locator,
        outputKey: await buildMasterPreviewKey(claim.spaceId, claim.sourceId, claim.kind),
        processingToken: claim.processingToken,
        executionCycle: claim.executionCycle,
        attemptNumber: claim.attemptNumber,
        allowedSourceOrigins: authorization.policy.allowedSourceOrigins,
      });
    } catch (error) {
      const code =
        error instanceof ProtocolError && error.code === "capability_expired"
          ? "source_expired"
          : "internal_invariant";
      await runtime.lifecycle.fail(claim, claim.processingToken, { retryable: false, code }, now);
      return requestFailure(409, code);
    }
  });

  api.post(CONTROL_HTTP_ROUTES.executorHeartbeat, async (context) => {
    const identity = identityFromRoute(context);
    if (
      identity === undefined ||
      !tokenMatches(bearer(context.req.header("authorization")), [
        runtime.executorToken(identity.kind) ?? "",
      ])
    ) {
      return requestFailure(401, "unauthorized");
    }
    let body: ExecutorHeartbeatRequest;
    try {
      body = parseExecutorHeartbeatRequest(await strictJson(context.req.raw));
    } catch {
      return requestFailure(400, "request_invalid");
    }
    const result = await runtime.lifecycle.heartbeat(identity, body.processingToken, runtime.now());
    return result.outcome === "accepted"
      ? new Response(null, { status: 204 })
      : requestFailure(409, "stale_attempt");
  });

  api.post(CONTROL_HTTP_ROUTES.executorComplete, async (context) => {
    const identity = identityFromRoute(context);
    if (
      identity === undefined ||
      !tokenMatches(bearer(context.req.header("authorization")), [
        runtime.executorToken(identity.kind) ?? "",
      ])
    ) {
      return requestFailure(401, "unauthorized");
    }
    let body: ExecutorCompleteRequest;
    try {
      body = parseExecutorCompleteRequest(await strictJson(context.req.raw));
    } catch {
      return requestFailure(400, "request_invalid");
    }
    const expectedKey = await buildMasterPreviewKey(
      identity.spaceId,
      identity.sourceId,
      identity.kind,
    );
    if (body.masterKey !== expectedKey) return requestFailure(400, "request_invalid");
    const completion: MasterCompletion = {
      masterKey: body.masterKey,
      width: body.width,
      height: body.height,
      format: "webp",
      objectEtag: body.objectEtag,
    };
    const result = await runtime.lifecycle.complete(
      identity,
      body.processingToken,
      completion,
      runtime.now(),
    );
    runtime.logger.emit(
      result.outcome === "accepted" ? "info" : "error",
      await operationalEvent({
        event:
          result.outcome === "accepted" ? "control.job.completed" : "executor.stale_completion",
        spaceId: identity.spaceId,
        sourceId: identity.sourceId,
        processingToken: body.processingToken,
        fields: {
          kind: identity.kind,
          outcome: result.outcome === "accepted" ? "ready" : "failed",
          ...(result.outcome === "accepted" ? {} : { failureCode: "stale_attempt" }),
        },
      }),
    );
    return result.outcome === "accepted"
      ? new Response(null, { status: 204 })
      : requestFailure(409, "stale_attempt");
  });

  api.post(CONTROL_HTTP_ROUTES.executorFail, async (context) => {
    const identity = identityFromRoute(context);
    if (
      identity === undefined ||
      !tokenMatches(bearer(context.req.header("authorization")), [
        runtime.executorToken(identity.kind) ?? "",
      ])
    ) {
      return requestFailure(401, "unauthorized");
    }
    let body: ExecutorFailRequest;
    try {
      body = parseExecutorFailRequest(await strictJson(context.req.raw));
    } catch {
      return requestFailure(400, "request_invalid");
    }
    const result = await runtime.lifecycle.fail(
      identity,
      body.processingToken,
      {
        retryable: body.retryable,
        ...(body.code === undefined ? {} : { code: body.code }),
      },
      runtime.now(),
    );
    runtime.logger.emit(
      result.outcome === "stale_attempt" ? "error" : "info",
      await operationalEvent({
        event: "control.job.failed",
        spaceId: identity.spaceId,
        sourceId: identity.sourceId,
        processingToken: body.processingToken,
        fields: {
          kind: identity.kind,
          outcome: "failed",
          ...(body.code === undefined ? {} : { failureCode: body.code }),
        },
      }),
    );
    return result.outcome === "stale_attempt"
      ? requestFailure(409, "stale_attempt")
      : new Response(null, { status: 204 });
  });

  return api;
}
