import { createHash, timingSafeEqual } from "node:crypto";
import {
  buildMasterPreviewKey,
  emitOperationalEvent,
  FAILURE_ACTIONS,
  type JobFailureCode,
  operationalEvent,
  ProtocolError,
  parsePreviewJobSubmission,
  type RenditionKind,
  verifySourceCapability,
} from "@shutter/protocol";
import { getSpacePolicy } from "@shutter/space-config";
import { Hono } from "hono";
import type { JobIdentity, JobStore, MasterCompletion } from "./job-store.js";
import { jobRepresentation } from "./job-store.js";
import type { SourcePurger } from "./source-purge.js";

type KeyRegistry = ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;

export interface JobApiRuntime {
  store: JobStore;
  now(): Date;
  spaceApiTokens(): ReadonlyMap<string, readonly string[]>;
  capabilityKeys(): KeyRegistry;
  executorToken(kind: RenditionKind): string | undefined;
  dispatch(kind: RenditionKind): Promise<void>;
  sourcePurger?: SourcePurger;
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

function failureCode(value: unknown): JobFailureCode | undefined {
  return typeof value === "string" && value in FAILURE_ACTIONS
    ? (value as JobFailureCode)
    : undefined;
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

function authorizedSpace(
  runtime: JobApiRuntime,
  spaceId: string,
  authorization: string | undefined,
): boolean {
  return tokenMatches(bearer(authorization), runtime.spaceApiTokens().get(spaceId) ?? []);
}

function activeResponse(body: ReturnType<typeof jobRepresentation>, location: string): Response {
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
  const resource = "/v1/spaces/:spaceId/sources/:sourceId/previews/:kind";

  api.post("/v1/spaces/:spaceId/sources/:sourceId/purge", async (context) => {
    const spaceId = context.req.param("spaceId");
    const sourceId = context.req.param("sourceId");
    if (getSpacePolicy(spaceId) === undefined) return requestFailure(404, "not_found");
    if (!authorizedSpace(runtime, spaceId, context.req.header("authorization"))) {
      return requestFailure(401, "unauthorized");
    }
    const purger = runtime.sourcePurger;
    if (purger === undefined) return requestFailure(503, "service_unavailable");
    try {
      await runtime.store.purgeSource(spaceId, sourceId, () => purger.purge(spaceId, sourceId));
      emitOperationalEvent(
        "info",
        await operationalEvent({
          event: "control.purge.completed",
          spaceId,
          sourceId,
          fields: { outcome: "ready" },
        }),
      );
      return new Response(null, { status: 204 });
    } catch {
      emitOperationalEvent(
        "error",
        await operationalEvent({
          event: "control.purge.failed",
          spaceId,
          sourceId,
          fields: { outcome: "failed", failureCode: "service_unavailable" },
        }),
      );
      return requestFailure(503, "service_unavailable");
    }
  });

  api.put(resource, async (context) => {
    const identity = identityFromRoute(context);
    if (identity === undefined) return requestFailure(404, "not_found");
    const policy = getSpacePolicy(identity.spaceId);
    if (policy === undefined) return requestFailure(404, "not_found");
    if (!authorizedSpace(runtime, identity.spaceId, context.req.header("authorization"))) {
      return requestFailure(401, "unauthorized");
    }
    try {
      const submission = parsePreviewJobSubmission(await strictJson(context.req.raw));
      const now = runtime.now();
      const claims = await verifySourceCapability(submission.sourceCapability, {
        spaceId: identity.spaceId,
        expectedPurpose: "preview_job",
        expectedSourceId: identity.sourceId,
        expectedKind: identity.kind,
        keys: runtime.capabilityKeys().get(identity.spaceId) ?? new Map(),
        now: Math.floor(now.getTime() / 1_000),
        allowedSourceOrigins: policy.allowedSourceOrigins,
      });
      const record = await runtime.store.submit(
        {
          ...identity,
          sourceCapability: submission.sourceCapability,
          capabilityExpiresAt: new Date(claims.exp * 1_000),
        },
        now,
      );
      emitOperationalEvent(
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
          }).then((event) => emitOperationalEvent("error", event));
        });
      }
      return activeResponse(jobRepresentation(record), new URL(context.req.url).pathname);
    } catch (error) {
      if (error instanceof ProtocolError) return requestFailure(400, error.code);
      emitOperationalEvent("error", {
        event: "control.service.failed",
        outcome: "failed",
        failureCode: "service_unavailable",
      });
      return requestFailure(503, "service_unavailable");
    }
  });

  api.get(resource, async (context) => {
    const identity = identityFromRoute(context);
    if (identity === undefined) return requestFailure(404, "not_found");
    if (!authorizedSpace(runtime, identity.spaceId, context.req.header("authorization"))) {
      return requestFailure(401, "unauthorized");
    }
    const record = await runtime.store.get(identity);
    if (record === undefined) return requestFailure(404, "not_found");
    return activeResponse(jobRepresentation(record), new URL(context.req.url).pathname);
  });

  api.post("/internal/v1/executors/:kind/claim", async (context) => {
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
    const claim = await runtime.store.claim(parsedKind, now);
    if (claim === undefined) return new Response(null, { status: 204 });
    const policy = getSpacePolicy(claim.spaceId);
    if (policy === undefined) {
      await runtime.store.fail(
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
        keys: runtime.capabilityKeys().get(claim.spaceId) ?? new Map(),
        now: Math.floor(now.getTime() / 1_000),
        allowedSourceOrigins: policy.allowedSourceOrigins,
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
      });
    } catch (error) {
      const code =
        error instanceof ProtocolError && error.code === "capability_expired"
          ? "source_expired"
          : "internal_invariant";
      await runtime.store.fail(claim, claim.processingToken, { retryable: false, code }, now);
      return requestFailure(409, code);
    }
  });

  const transition = "/internal/v1/executors/:kind/jobs/:spaceId/:sourceId";
  api.post(`${transition}/heartbeat`, async (context) => {
    const identity = identityFromRoute(context);
    if (
      identity === undefined ||
      !tokenMatches(bearer(context.req.header("authorization")), [
        runtime.executorToken(identity.kind) ?? "",
      ])
    ) {
      return requestFailure(401, "unauthorized");
    }
    let body: { processingToken?: unknown };
    try {
      body = (await strictJson(context.req.raw)) as { processingToken?: unknown };
    } catch {
      return requestFailure(400, "request_invalid");
    }
    if (typeof body.processingToken !== "string") return requestFailure(400, "request_invalid");
    const updated = await runtime.store.heartbeat(identity, body.processingToken, runtime.now());
    return updated ? new Response(null, { status: 204 }) : requestFailure(409, "stale_attempt");
  });

  api.post(`${transition}/complete`, async (context) => {
    const identity = identityFromRoute(context);
    if (
      identity === undefined ||
      !tokenMatches(bearer(context.req.header("authorization")), [
        runtime.executorToken(identity.kind) ?? "",
      ])
    ) {
      return requestFailure(401, "unauthorized");
    }
    let body: Record<string, unknown>;
    try {
      body = (await strictJson(context.req.raw)) as Record<string, unknown>;
    } catch {
      return requestFailure(400, "request_invalid");
    }
    if (
      Object.keys(body).sort().join(",") !==
        "format,height,masterKey,objectEtag,processingToken,width" ||
      typeof body.processingToken !== "string" ||
      typeof body.masterKey !== "string" ||
      !Number.isSafeInteger(body.width) ||
      !Number.isSafeInteger(body.height) ||
      body.format !== "webp" ||
      typeof body.objectEtag !== "string"
    ) {
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
      width: body.width as number,
      height: body.height as number,
      format: "webp",
      objectEtag: body.objectEtag,
    };
    const updated = await runtime.store.complete(
      identity,
      body.processingToken,
      completion,
      runtime.now(),
    );
    emitOperationalEvent(
      updated ? "info" : "error",
      await operationalEvent({
        event: updated ? "control.job.completed" : "executor.stale_completion",
        spaceId: identity.spaceId,
        sourceId: identity.sourceId,
        processingToken: body.processingToken,
        fields: {
          kind: identity.kind,
          outcome: updated ? "ready" : "failed",
          ...(updated ? {} : { failureCode: "stale_attempt" }),
        },
      }),
    );
    return updated ? new Response(null, { status: 204 }) : requestFailure(409, "stale_attempt");
  });

  api.post(`${transition}/fail`, async (context) => {
    const identity = identityFromRoute(context);
    if (
      identity === undefined ||
      !tokenMatches(bearer(context.req.header("authorization")), [
        runtime.executorToken(identity.kind) ?? "",
      ])
    ) {
      return requestFailure(401, "unauthorized");
    }
    let body: Record<string, unknown>;
    try {
      body = (await strictJson(context.req.raw)) as Record<string, unknown>;
    } catch {
      return requestFailure(400, "request_invalid");
    }
    const code = body.code === undefined ? undefined : failureCode(body.code);
    if (
      typeof body.processingToken !== "string" ||
      typeof body.retryable !== "boolean" ||
      (body.code !== undefined && code === undefined)
    ) {
      return requestFailure(400, "request_invalid");
    }
    const updated = await runtime.store.fail(
      identity,
      body.processingToken,
      { retryable: body.retryable, ...(code === undefined ? {} : { code }) },
      runtime.now(),
    );
    emitOperationalEvent(
      updated ? "info" : "error",
      await operationalEvent({
        event: "control.job.failed",
        spaceId: identity.spaceId,
        sourceId: identity.sourceId,
        processingToken: body.processingToken,
        fields: {
          kind: identity.kind,
          outcome: "failed",
          ...(code === undefined ? {} : { failureCode: code }),
        },
      }),
    );
    return updated ? new Response(null, { status: 204 }) : requestFailure(409, "stale_attempt");
  });

  return api;
}
