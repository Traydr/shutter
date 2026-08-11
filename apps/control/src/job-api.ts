import { createHash, timingSafeEqual } from "node:crypto";
import {
  buildMasterPreviewKey,
  CONTROL_HTTP_ROUTES,
  type ExecutorCompleteRequest,
  type ExecutorFailRequest,
  operationalEvent,
  type RenditionJobRepresentation,
  type RenditionKind,
  SubmissionError,
  verifySourceCapability,
} from "@shutter/protocol";
import {
  parseExecutorCompleteRequest,
  parseExecutorFailRequest,
  parseExecutorHeartbeatRequest,
  parsePreviewJobSubmission,
} from "@shutter/protocol/jobs";
import { getSpacePolicy } from "@shutter/space-config";
import { Cause, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { ExecutorDispatchShape } from "./executor-dispatch.js";
import { type ControlLoggerShape, operationalErrorType } from "./logging.js";
import type {
  JobIdentity,
  MasterCompletion,
  RenditionJobLifecycleShape,
} from "./rendition-job-lifecycle.js";
import type { SourcePurgeShape } from "./source-purge.js";

type KeyRegistry = ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;

export interface JobApiRuntime {
  logger: ControlLoggerShape;
  lifecycle: RenditionJobLifecycleShape;
  now(): Date;
  spaceApiTokens(): ReadonlyMap<string, readonly string[]>;
  capabilityKeys(): KeyRegistry;
  executorToken(kind: RenditionKind): string | undefined;
  dispatch: ExecutorDispatchShape["dispatch"];
  sourcePurge?: SourcePurgeShape;
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

function kind(value: string | undefined): RenditionKind | undefined {
  return value === "video" || value === "pdf" ? value : undefined;
}

function identityFromRoute(
  params: Readonly<Record<string, string | undefined>>,
): JobIdentity | undefined {
  const parsedKind = kind(params.kind);
  const spaceId = params.spaceId;
  const sourceId = params.sourceId;
  if (parsedKind === undefined || spaceId === undefined || sourceId === undefined) return undefined;
  return { spaceId, sourceId, kind: parsedKind };
}

function authorizedSpace(
  runtime: JobApiRuntime,
  spaceId: string,
  authorization: string | undefined,
): boolean {
  return tokenMatches(bearer(authorization), runtime.spaceApiTokens().get(spaceId) ?? []);
}

function activeResponse(body: RenditionJobRepresentation, location: string) {
  const active = body.status === "pending" || body.status === "processing";
  return HttpServerResponse.jsonUnsafe(body, {
    status: active ? 202 : 200,
    ...(active ? { headers: { location, "retry-after": "5" } } : {}),
  });
}

function requestFailure(status: number, code: string) {
  return HttpServerResponse.jsonUnsafe(
    { error: { code } },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}

function strictJson(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      return yield* new SubmissionError({
        code: "submission_invalid",
        message: "request must use application/json",
      });
    }
    return yield* request.json.pipe(
      Effect.mapError(
        () =>
          new SubmissionError({
            code: "request_invalid",
            message: "request body must be valid JSON",
          }),
      ),
    );
  });
}

function safeJobHandler<E, R>(
  runtime: JobApiRuntime,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return effect.pipe(
    Effect.catchCause((cause) =>
      runtime.logger
        .emit("error", {
          event: "control.service.failed",
          outcome: "failed",
          failureCode: "service_unavailable",
          errorType: operationalErrorType(Cause.squash(cause)),
        })
        .pipe(Effect.as(requestFailure(503, "service_unavailable"))),
    ),
  );
}

export function createJobRoutes(runtime: JobApiRuntime) {
  const sourcePurge = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const spaceId = params.spaceId;
    const sourceId = params.sourceId;
    if (spaceId === undefined || sourceId === undefined || getSpacePolicy(spaceId) === undefined) {
      return requestFailure(404, "not_found");
    }
    if (!authorizedSpace(runtime, spaceId, request.headers.authorization)) {
      return requestFailure(401, "unauthorized");
    }
    if (runtime.sourcePurge === undefined) return requestFailure(503, "service_unavailable");
    return yield* runtime.sourcePurge.purge({ spaceId, sourceId }).pipe(
      Effect.as(HttpServerResponse.empty()),
      Effect.catch(() => Effect.succeed(requestFailure(503, "service_unavailable"))),
    );
  });

  const submit = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const identity = identityFromRoute(params);
    if (identity === undefined) return requestFailure(404, "not_found");
    const policy = getSpacePolicy(identity.spaceId);
    if (policy === undefined) return requestFailure(404, "not_found");
    if (!authorizedSpace(runtime, identity.spaceId, request.headers.authorization)) {
      return requestFailure(401, "unauthorized");
    }

    const parsed = yield* Effect.gen(function* () {
      const submission = yield* strictJson(request).pipe(
        Effect.flatMap((body) => parsePreviewJobSubmission(body)),
      );
      const now = runtime.now();
      const claims = yield* verifySourceCapability(submission.sourceCapability, {
        spaceId: identity.spaceId,
        expectedPurpose: "preview_job",
        expectedSourceId: identity.sourceId,
        expectedKind: identity.kind,
        keys: runtime.capabilityKeys().get(identity.spaceId) ?? new Map(),
        now: Math.floor(now.getTime() / 1_000),
        allowedSourceOrigins: policy.allowedSourceOrigins,
      });
      return { submission, now, claims };
    }).pipe(
      Effect.map((value) => ({ _tag: "Success" as const, value })),
      Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
    );
    if (parsed._tag === "Failure") return requestFailure(400, parsed.error.code);

    const { submission, now, claims } = parsed.value;
    const submissionResult = yield* runtime.lifecycle.submit(
      {
        ...identity,
        sourceCapability: submission.sourceCapability,
        capabilityExpiresAt: new Date(claims.exp * 1_000),
      },
      now,
    );
    const record = submissionResult.job;
    const event = yield* operationalEvent({
      event: "control.job.submitted",
      spaceId: record.spaceId,
      sourceId: record.sourceId,
      fields: {
        kind: record.kind,
        executionCycle: record.executionCycle,
        attemptNumber: record.attemptNumber,
        outcome: "accepted",
      },
    });
    yield* runtime.logger.emit("info", event);
    if (record.status === "pending") {
      const dispatch = runtime.dispatch(record.kind).pipe(
        Effect.tapCause(() =>
          operationalEvent({
            event: "control.dispatch.failed",
            spaceId: record.spaceId,
            sourceId: record.sourceId,
            fields: {
              kind: record.kind,
              outcome: "failed",
              failureCode: "service_unavailable",
            },
          }).pipe(Effect.flatMap((failureEvent) => runtime.logger.emit("error", failureEvent))),
        ),
      );
      yield* Effect.forkDetach(dispatch);
    }
    return activeResponse(record.representation, new URL(request.originalUrl).pathname);
  });

  const read = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const identity = identityFromRoute(params);
    if (identity === undefined) return requestFailure(404, "not_found");
    if (!authorizedSpace(runtime, identity.spaceId, request.headers.authorization)) {
      return requestFailure(401, "unauthorized");
    }
    const record = yield* runtime.lifecycle.read(identity);
    if (record === undefined) return requestFailure(404, "not_found");
    return activeResponse(record.representation, new URL(request.originalUrl).pathname);
  });

  const claim = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const parsedKind = kind(params.kind);
    if (
      parsedKind === undefined ||
      !tokenMatches(bearer(request.headers.authorization), [
        runtime.executorToken(parsedKind) ?? "",
      ])
    ) {
      return requestFailure(401, "unauthorized");
    }
    const now = runtime.now();
    const claimed = yield* runtime.lifecycle.claim(parsedKind, now);
    if (claimed === undefined) return HttpServerResponse.empty();
    const policy = getSpacePolicy(claimed.spaceId);
    if (policy === undefined) {
      yield* runtime.lifecycle.fail(
        claimed,
        claimed.processingToken,
        { retryable: false, code: "configuration_error" },
        now,
      );
      return requestFailure(503, "configuration_error");
    }
    const verified = yield* verifySourceCapability(claimed.sourceCapability, {
      spaceId: claimed.spaceId,
      expectedPurpose: "preview_job",
      expectedSourceId: claimed.sourceId,
      expectedKind: claimed.kind,
      keys: runtime.capabilityKeys().get(claimed.spaceId) ?? new Map(),
      now: Math.floor(now.getTime() / 1_000),
      allowedSourceOrigins: policy.allowedSourceOrigins,
    }).pipe(
      Effect.map((claims) => ({ _tag: "Success" as const, claims })),
      Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
    );
    if (verified._tag === "Failure") {
      const code =
        verified.error.code === "capability_expired" ? "source_expired" : "internal_invariant";
      yield* runtime.lifecycle.fail(
        claimed,
        claimed.processingToken,
        { retryable: false, code },
        now,
      );
      return requestFailure(409, code);
    }
    return HttpServerResponse.jsonUnsafe({
      spaceId: claimed.spaceId,
      sourceId: claimed.sourceId,
      kind: claimed.kind,
      locator: verified.claims.locator,
      outputKey: yield* Effect.promise(() =>
        buildMasterPreviewKey(claimed.spaceId, claimed.sourceId, claimed.kind),
      ),
      processingToken: claimed.processingToken,
      executionCycle: claimed.executionCycle,
      attemptNumber: claimed.attemptNumber,
    });
  });

  const heartbeat = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const identity = identityFromRoute(yield* HttpRouter.params);
    if (
      identity === undefined ||
      !tokenMatches(bearer(request.headers.authorization), [
        runtime.executorToken(identity.kind) ?? "",
      ])
    )
      return requestFailure(401, "unauthorized");
    const parsed = yield* strictJson(request).pipe(
      Effect.flatMap((body) => parseExecutorHeartbeatRequest(body)),
      Effect.map((body) => ({ _tag: "Success" as const, body })),
      Effect.catch(() => Effect.succeed({ _tag: "Failure" as const })),
    );
    if (parsed._tag === "Failure") return requestFailure(400, "request_invalid");
    const result = yield* runtime.lifecycle.heartbeat(
      identity,
      parsed.body.processingToken,
      runtime.now(),
    );
    return result.outcome === "accepted"
      ? HttpServerResponse.empty()
      : requestFailure(409, "stale_attempt");
  });

  const complete = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const identity = identityFromRoute(yield* HttpRouter.params);
    if (
      identity === undefined ||
      !tokenMatches(bearer(request.headers.authorization), [
        runtime.executorToken(identity.kind) ?? "",
      ])
    )
      return requestFailure(401, "unauthorized");
    const parsed = yield* strictJson(request).pipe(
      Effect.flatMap((body) => parseExecutorCompleteRequest(body)),
      Effect.map((body) => ({ _tag: "Success" as const, body })),
      Effect.catch(() => Effect.succeed({ _tag: "Failure" as const })),
    );
    if (parsed._tag === "Failure") return requestFailure(400, "request_invalid");
    const body: ExecutorCompleteRequest = parsed.body;
    const expectedKey = yield* Effect.promise(() =>
      buildMasterPreviewKey(identity.spaceId, identity.sourceId, identity.kind),
    );
    if (body.masterKey !== expectedKey) return requestFailure(400, "request_invalid");
    const completion: MasterCompletion = {
      masterKey: body.masterKey,
      width: body.width,
      height: body.height,
      format: "webp",
      objectEtag: body.objectEtag,
    };
    const result = yield* runtime.lifecycle.complete(
      identity,
      body.processingToken,
      completion,
      runtime.now(),
    );
    const event = yield* operationalEvent({
      event: result.outcome === "accepted" ? "control.job.completed" : "executor.stale_completion",
      spaceId: identity.spaceId,
      sourceId: identity.sourceId,
      processingToken: body.processingToken,
      fields: {
        kind: identity.kind,
        outcome: result.outcome === "accepted" ? "ready" : "failed",
        ...(result.outcome === "accepted" ? {} : { failureCode: "stale_attempt" }),
      },
    });
    yield* runtime.logger.emit(result.outcome === "accepted" ? "info" : "error", event);
    return result.outcome === "accepted"
      ? HttpServerResponse.empty()
      : requestFailure(409, "stale_attempt");
  });

  const fail = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const identity = identityFromRoute(yield* HttpRouter.params);
    if (
      identity === undefined ||
      !tokenMatches(bearer(request.headers.authorization), [
        runtime.executorToken(identity.kind) ?? "",
      ])
    )
      return requestFailure(401, "unauthorized");
    const parsed = yield* strictJson(request).pipe(
      Effect.flatMap((body) => parseExecutorFailRequest(body)),
      Effect.map((body) => ({ _tag: "Success" as const, body })),
      Effect.catch(() => Effect.succeed({ _tag: "Failure" as const })),
    );
    if (parsed._tag === "Failure") return requestFailure(400, "request_invalid");
    const body: ExecutorFailRequest = parsed.body;
    const result = yield* runtime.lifecycle.fail(
      identity,
      body.processingToken,
      { retryable: body.retryable, ...(body.code === undefined ? {} : { code: body.code }) },
      runtime.now(),
    );
    const event = yield* operationalEvent({
      event: "control.job.failed",
      spaceId: identity.spaceId,
      sourceId: identity.sourceId,
      processingToken: body.processingToken,
      fields: {
        kind: identity.kind,
        outcome: "failed",
        ...(body.code === undefined ? {} : { failureCode: body.code }),
      },
    });
    yield* runtime.logger.emit(result.outcome === "stale_attempt" ? "error" : "info", event);
    return result.outcome === "stale_attempt"
      ? requestFailure(409, "stale_attempt")
      : HttpServerResponse.empty();
  });

  return HttpRouter.addAll([
    HttpRouter.route("POST", CONTROL_HTTP_ROUTES.sourcePurge, safeJobHandler(runtime, sourcePurge)),
    HttpRouter.route("PUT", CONTROL_HTTP_ROUTES.previewJob, safeJobHandler(runtime, submit)),
    HttpRouter.route("GET", CONTROL_HTTP_ROUTES.previewJob, safeJobHandler(runtime, read)),
    HttpRouter.route("POST", CONTROL_HTTP_ROUTES.executorClaim, safeJobHandler(runtime, claim)),
    HttpRouter.route(
      "POST",
      CONTROL_HTTP_ROUTES.executorHeartbeat,
      safeJobHandler(runtime, heartbeat),
    ),
    HttpRouter.route(
      "POST",
      CONTROL_HTTP_ROUTES.executorComplete,
      safeJobHandler(runtime, complete),
    ),
    HttpRouter.route("POST", CONTROL_HTTP_ROUTES.executorFail, safeJobHandler(runtime, fail)),
  ]);
}

export function createJobApi(runtime: JobApiRuntime) {
  const web = HttpRouter.toWebHandler(createJobRoutes(runtime), { disableLogger: true });
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return web.handler(input instanceof Request ? input : new Request(input, init));
    },
    dispose: web.dispose,
  };
}
