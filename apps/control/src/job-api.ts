import { createHash, timingSafeEqual } from "node:crypto";
import {
  buildMasterPreviewKey,
  CONTROL_HTTP_ROUTES,
  type ExecutorCompleteRequest,
  type ExecutorFailRequest,
  type ExecutorHeartbeatRequest,
  type JsonValue,
  type OperationalEventFields,
  operationalEvent,
  type PreviewJobRepresentation,
  type PreviewKind,
  ProtocolError,
  parseExecutorCompleteRequest,
  parseExecutorFailRequest,
  parseExecutorHeartbeatRequest,
  parsePreviewJobSubmission,
  parsePreviewJobSubmissionV2,
  parseSourceReference,
  type SpacePolicy,
  verifySourceCapability,
} from "@shutter/protocol";
import { Hono } from "hono";
import { type ControlLogger, operationalErrorType } from "./logging.js";
import type {
  AttemptFailure,
  ClaimedJob,
  JobIdentity,
  MasterCompletion,
  PreviewJobLifecycle,
  PreviewJobView,
} from "./preview-job-lifecycle.js";
import { type ProblemCode, problemResponse } from "./problems.js";
import type { SourcePurge } from "./source-purge.js";
import type { Resolution, SourceResolverService } from "./source-resolvers.js";
import type { ActiveSpaceAuthorization, SpaceRegistry } from "./spaces/registry.js";

export interface JobApiRuntime {
  logger: ControlLogger;
  lifecycle: PreviewJobLifecycle;
  now(): Date;
  spaceRegistry: SpaceRegistry;
  executorToken(kind: PreviewKind): string | undefined;
  dispatch(kind: PreviewKind): Promise<void>;
  sourcePurge?: SourcePurge;
  /** Resolves a resolver source's locator when an Executor claims its job (ADR 0027). */
  sourceResolvers?: SourceResolverService;
}

/**
 * How long a locator presigned at claim time stays valid: the processing
 * lease plus room for a large download. A retry gets a fresh one.
 */
export const CLAIM_LOCATOR_LIFETIME_SECONDS = 60 * 60;

type JobApiEnv = { Variables: { requestId?: string } };

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

function kind(value: string): PreviewKind | undefined {
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
  failure: (code: ProblemCode) => Response = (code) => requestFailure(STATUS[code], code),
): Promise<{ response: Response } | { authorization: ActiveSpaceAuthorization }> {
  try {
    const result = await runtime.spaceRegistry.authorizeSpaceRequest(
      spaceId,
      bearer(authorizationHeader),
    );
    switch (result.outcome) {
      case "missing":
        return { response: failure("not_found") };
      case "unauthorized":
        return { response: failure("unauthorized") };
      case "authorized":
        return { authorization: { policy: result.policy, capabilityKeys: result.capabilityKeys } };
    }
  } catch {
    return { response: failure("service_unavailable") };
  }
}

const STATUS = {
  unauthorized: 401,
  not_found: 404,
  request_invalid: 400,
  service_unavailable: 503,
  configuration_error: 503,
  internal_invariant: 409,
} as const satisfies Record<ProblemCode, number>;

const RESOLVER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;

/**
 * Whether a Source ID has the `{resolver}/{reference}` shape a v2 route
 * accepts. Reads and purges use this rather than `resolverSource`, so a job
 * whose resolver has since been removed can still be polled and cleaned up.
 */
function isResolverSourceId(sourceId: string): boolean {
  const separator = sourceId.indexOf("/");
  return (
    separator > 0 &&
    RESOLVER_ID_PATTERN.test(sourceId.slice(0, separator)) &&
    sourceId.length > separator + 1
  );
}

/**
 * A resolver Source ID split back into its resolver and reference, accepted
 * only when the Space has that resolver and the reference fits it. A v2
 * submission names nothing else.
 */
function resolverSource(
  policy: SpacePolicy,
  sourceId: string,
): { resolverId: string; reference: readonly string[] } | undefined {
  const [resolverId, ...reference] = sourceId.split("/");
  if (resolverId === undefined || reference.length === 0) return undefined;
  const resolver = policy.resolvers.find((candidate) => candidate.id === resolverId);
  if (resolver === undefined) return undefined;
  return parseSourceReference(resolver, reference) === undefined
    ? undefined
    : { resolverId, reference };
}

function activeResponse(body: PreviewJobRepresentation, location: string): Response {
  const active = body.status === "pending" || body.status === "processing";
  if (active) {
    return Response.json(body, { status: 202, headers: { location, "retry-after": "5" } });
  }
  return Response.json(body, { status: 200 });
}

function requestFailure(status: number, code: string): Response {
  return Response.json(
    { error: { code } },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}

async function strictJson(request: Request): Promise<JsonValue> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ProtocolError("submission_invalid", "request must use application/json");
  }
  return request.json();
}

/** A claim whose resolver source cannot be resolved; the job fails with this code. */
class ClaimResolutionError extends Error {
  readonly code: "configuration_error" | "internal_invariant" | "service_unavailable";

  constructor(code: "configuration_error" | "internal_invariant" | "service_unavailable") {
    super(`claim resolution failed: ${code}`);
    this.name = "ClaimResolutionError";
    this.code = code;
  }
}

/**
 * The locator an Executor fetches from for this attempt: the capability's
 * for a v1 job, a fresh expansion or presign for a resolver source. Neither
 * touches the retry budget (ADR 0027).
 */
async function claimLocator(
  runtime: JobApiRuntime,
  claim: ClaimedJob,
  authorization: ActiveSpaceAuthorization,
  now: Date,
): Promise<string> {
  if (claim.sourceCapability !== undefined) {
    const claims = await verifySourceCapability(claim.sourceCapability, {
      spaceId: claim.spaceId,
      expectedPurpose: "preview_job",
      expectedSourceId: claim.sourceId,
      expectedKind: claim.kind,
      keys: authorization.capabilityKeys,
      now: Math.floor(now.getTime() / 1_000),
      allowedSourceOrigins: authorization.policy.allowedSourceOrigins,
    });
    return claims.locator;
  }
  const resolvers = runtime.sourceResolvers;
  const source = resolverSource(authorization.policy, claim.sourceId);
  if (resolvers === undefined || source === undefined) {
    throw new ClaimResolutionError("configuration_error");
  }
  let resolution: Resolution;
  try {
    resolution = await resolvers.resolve({
      policy: authorization.policy,
      resolverId: source.resolverId,
      reference: source.reference,
      lifetimeSeconds: CLAIM_LOCATOR_LIFETIME_SECONDS,
      now,
    });
  } catch {
    // A registry or presign fault is temporary: the attempt is left to its
    // lease, which recovery returns to pending, and the budget is untouched.
    throw new ClaimResolutionError("service_unavailable");
  }
  if (resolution.outcome === "resolved") return resolution.locator;
  throw new ClaimResolutionError(
    resolution.outcome === "not_allowed" ? "internal_invariant" : "configuration_error",
  );
}

/**
 * The failure code a claim-time fault settles the job with, or `undefined`
 * when the fault is temporary and the attempt should be left to its lease.
 */
function terminalClaimFailure(
  cause: unknown,
): "source_expired" | "configuration_error" | "internal_invariant" | undefined {
  if (cause instanceof ClaimResolutionError) {
    return cause.code === "service_unavailable" ? undefined : cause.code;
  }
  if (cause instanceof ProtocolError && cause.code === "capability_expired") {
    return "source_expired";
  }
  return "internal_invariant";
}

async function emitSubmitted(runtime: JobApiRuntime, record: PreviewJobView): Promise<void> {
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
}

function dispatchPending(runtime: JobApiRuntime, record: PreviewJobView): void {
  if (record.status !== "pending") return;
  void runtime.dispatch(record.kind).catch(() => {
    void operationalEvent({
      event: "control.dispatch.failed",
      spaceId: record.spaceId,
      sourceId: record.sourceId,
      fields: { kind: record.kind, outcome: "failed", failureCode: "service_unavailable" },
    }).then((event) => runtime.logger.emit("error", event));
  });
}

export function createJobApi(runtime: JobApiRuntime): Hono<JobApiEnv> {
  const api = new Hono<JobApiEnv>();

  // v2: resolver sources, no capability, problem-details errors.

  api.post(CONTROL_HTTP_ROUTES.sourcePurgeV2, async (context) => {
    const problem = (code: ProblemCode) => problemResponse(code, context.get("requestId"));
    const spaceId = context.req.param("spaceId");
    const sourceId = context.req.param("sourceId");
    const access = await spaceAccess(
      runtime,
      spaceId,
      context.req.header("authorization"),
      problem,
    );
    if ("response" in access) return access.response;
    if (!isResolverSourceId(sourceId)) return problem("not_found");
    const sourcePurge = runtime.sourcePurge;
    if (sourcePurge === undefined) return problem("service_unavailable");
    try {
      await sourcePurge.purge({ spaceId, sourceId });
      return new Response(null, { status: 204 });
    } catch {
      return problem("service_unavailable");
    }
  });

  api.put(CONTROL_HTTP_ROUTES.previewJobV2, async (context) => {
    const problem = (code: ProblemCode) => problemResponse(code, context.get("requestId"));
    const identity = identityFromRoute(context);
    if (identity === undefined) return problem("not_found");
    const access = await spaceAccess(
      runtime,
      identity.spaceId,
      context.req.header("authorization"),
      problem,
    );
    if ("response" in access) return access.response;
    if (resolverSource(access.authorization.policy, identity.sourceId) === undefined) {
      return problem("not_found");
    }
    try {
      parsePreviewJobSubmissionV2(await strictJson(context.req.raw));
    } catch {
      return problem("request_invalid");
    }
    try {
      const submission = await runtime.lifecycle.submit(identity, runtime.now());
      await emitSubmitted(runtime, submission.job);
      dispatchPending(runtime, submission.job);
      return activeResponse(submission.job.representation, new URL(context.req.url).pathname);
    } catch (error) {
      runtime.logger.emit("error", {
        event: "control.service.failed",
        outcome: "failed",
        failureCode: "service_unavailable",
        errorType: operationalErrorType(error),
      });
      return problem("service_unavailable");
    }
  });

  api.get(CONTROL_HTTP_ROUTES.previewJobV2, async (context) => {
    const problem = (code: ProblemCode) => problemResponse(code, context.get("requestId"));
    const identity = identityFromRoute(context);
    if (identity === undefined) return problem("not_found");
    const access = await spaceAccess(
      runtime,
      identity.spaceId,
      context.req.header("authorization"),
      problem,
    );
    if ("response" in access) return access.response;
    if (!isResolverSourceId(identity.sourceId)) return problem("not_found");
    let record: PreviewJobView | undefined;
    try {
      record = await runtime.lifecycle.read(identity);
    } catch {
      return problem("service_unavailable");
    }
    if (record === undefined) return problem("not_found");
    return activeResponse(record.representation, new URL(context.req.url).pathname);
  });

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
      await emitSubmitted(runtime, record);
      dispatchPending(runtime, record);
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
      const locator = await claimLocator(runtime, claim, authorization, now);
      return context.json({
        spaceId: claim.spaceId,
        sourceId: claim.sourceId,
        kind: claim.kind,
        locator,
        outputKey: await buildMasterPreviewKey(claim.spaceId, claim.sourceId, claim.kind),
        processingToken: claim.processingToken,
        executionCycle: claim.executionCycle,
        attemptNumber: claim.attemptNumber,
        allowedSourceOrigins: authorization.policy.allowedSourceOrigins,
      });
    } catch (error) {
      const code = terminalClaimFailure(error);
      if (code === undefined) return requestFailure(503, "service_unavailable");
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
        fields:
          result.outcome === "accepted"
            ? { kind: identity.kind, outcome: "ready" }
            : { kind: identity.kind, outcome: "failed", failureCode: "stale_attempt" },
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
    const failure: AttemptFailure = { retryable: body.retryable };
    const fields: OperationalEventFields = { kind: identity.kind, outcome: "failed" };
    if (body.code !== undefined) {
      failure.code = body.code;
      fields.failureCode = body.code;
    }
    const result = await runtime.lifecycle.fail(
      identity,
      body.processingToken,
      failure,
      runtime.now(),
    );
    runtime.logger.emit(
      result.outcome === "stale_attempt" ? "error" : "info",
      await operationalEvent({
        event: "control.job.failed",
        spaceId: identity.spaceId,
        sourceId: identity.sourceId,
        processingToken: body.processingToken,
        fields,
      }),
    );
    return result.outcome === "stale_attempt"
      ? requestFailure(409, "stale_attempt")
      : new Response(null, { status: 204 });
  });

  return api;
}
