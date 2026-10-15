import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { faviconIcoResponse, faviconSvgResponse } from "@shutter/assets";
import {
  EXECUTOR_WAKE_ROUTE,
  type ExecutorClaim,
  type ExecutorInvocationResult,
  type ExecutorWakeReply,
  type JobFailureCode,
  type OperationalEvent,
  type OperationalEventFields,
  operationalErrorType,
  operationalEvent,
  type PreviewKind,
  parseExecutorClaim,
  type SourceOriginRule,
  sanitizeOperationalEvent,
} from "@shutter/protocol";
import { Hono } from "hono";

export {
  type CommandRunner,
  downloadSource,
  ProcessingFailure,
  parseFfprobeDimensions,
  probeWebpDimensions,
  runCommand,
} from "./media.js";

/** How often a running attempt renews its fifteen-minute processing lease. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * The whole attempt, download through upload, ends by here: the contract's
 * ten-minute hard timeout, inside the processing lease and inside the
 * eleven minutes Control waits on a wake.
 */
export const ATTEMPT_DEADLINE_MS = 10 * 60 * 1_000;

/** One request to Control; a slower one counts as failed. */
export const CONTROL_REQUEST_TIMEOUT_MS = 30_000;

/** The part of the S3 client the executor depends on: sending put and delete commands. */
export type MediaStoreClient = Pick<S3Client, "send">;

export interface ExecutorConfig {
  controlBaseUrl: string;
  roleToken: string;
  bucket: string;
  s3: MediaStoreClient;
  fetch: typeof globalThis.fetch;
}

export interface ProcessedMasterPreview {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** How a processing failure is reported to Control: whether to retry, and the code when known. */
export interface ExecutorFailure {
  retryable: boolean;
  code?: JobFailureCode;
}

/** One attempt's work order for a processor. */
export interface ProcessInput {
  locator: string;
  /** A private scratch directory, removed after the attempt. */
  directory: string;
  fetch: typeof globalThis.fetch;
  allowedSourceOrigins: readonly SourceOriginRule[];
  /**
   * Aborts when Control reports the attempt stale or the attempt reaches its
   * deadline. The processor stops its download and child processes and rejects.
   */
  signal: AbortSignal;
}

export interface ExecutorProcessor {
  kind: PreviewKind;
  process(input: ProcessInput): Promise<ProcessedMasterPreview>;
  /** Classifies whatever `process` threw. */
  failure(cause: unknown): ExecutorFailure;
}

/** Control answered a heartbeat with `409`: the job is no longer this attempt's. */
class StaleAttempt extends Error {
  constructor() {
    super("Control no longer recognizes this attempt");
    this.name = "StaleAttempt";
  }
}

/** The attempt reached `ATTEMPT_DEADLINE_MS`. */
class AttemptDeadlineExceeded extends Error {
  constructor() {
    super("attempt deadline exceeded");
    this.name = "AttemptDeadlineExceeded";
  }
}

async function control(config: ExecutorConfig, path: string, init: RequestInit): Promise<Response> {
  return config.fetch(new URL(path, config.controlBaseUrl), {
    ...init,
    headers: { authorization: `Bearer ${config.roleToken}`, ...init.headers },
    signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
  });
}

/** Settles as `work` does, or rejects with the abort reason as soon as `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);

    if (signal.aborted) abort();

    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Renews the attempt's lease. A `409` means the job is no longer this
 * attempt's, so the attempt is aborted; any other failure is logged and left
 * to the next beat, since the lease outlasts many missed ones.
 */
async function sendHeartbeat(
  config: ExecutorConfig,
  path: string,
  claim: ExecutorClaim,
  attempt: AbortController,
): Promise<void> {
  const fields: OperationalEventFields = {
    kind: claim.kind,
    executionCycle: claim.executionCycle,
    attemptNumber: claim.attemptNumber,
    outcome: "failed",
    failureCode: "service_unavailable",
  };

  try {
    const response = await control(config, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ processingToken: claim.processingToken }),
    });
    await response.body?.cancel();

    if (response.ok) return;

    if (response.status === 409) {
      attempt.abort(new StaleAttempt());
      return;
    }

    fields.httpStatusCode = response.status;
  } catch (error) {
    fields.errorType = operationalErrorType(error);
  }

  emitExecutorEvent(
    "error",
    await operationalEvent({
      event: "executor.heartbeat_failed",
      spaceId: claim.spaceId,
      sourceId: claim.sourceId,
      processingToken: claim.processingToken,
      fields,
    }),
  );
}

export async function runExecutorOnce(
  config: ExecutorConfig,
  processor: ExecutorProcessor,
): Promise<ExecutorInvocationResult> {
  const claimed = await control(config, `/internal/v1/executors/${processor.kind}/claim`, {
    method: "POST",
  });
  if (claimed.status === 204) return "idle";

  // Control settled a job for good while serving the claim (its resolver is
  // gone, its capability expired): that job is done with, and there may be more.
  if (claimed.status === 409) {
    await claimed.body?.cancel();
    return "processed";
  }

  if (!claimed.ok) throw new Error(`Control claim failed with ${claimed.status}`);
  const claim = parseExecutorClaim(await claimed.json());
  if (claim.kind !== processor.kind) throw new Error("Control returned the wrong preview kind");
  const startedAt = Date.now();
  emitExecutorEvent(
    "info",
    await operationalEvent({
      event: "executor.claimed",
      spaceId: claim.spaceId,
      sourceId: claim.sourceId,
      processingToken: claim.processingToken,
      fields: {
        kind: claim.kind,
        executionCycle: claim.executionCycle,
        attemptNumber: claim.attemptNumber,
        outcome: "accepted",
      },
    }),
  );
  const directory = await mkdtemp(join(tmpdir(), `shutter-${processor.kind}-`));
  let uploaded = false;
  let objectEtag: string | undefined;
  const transition = `/internal/v1/executors/${processor.kind}/jobs/${encodeURIComponent(claim.spaceId)}/${encodeURIComponent(claim.sourceId)}`;
  const attempt = new AbortController();
  const deadline = setTimeout(
    () => attempt.abort(new AttemptDeadlineExceeded()),
    ATTEMPT_DEADLINE_MS,
  );
  const heartbeat = setInterval(() => {
    // A heartbeat never throws into the process: Control being briefly
    // unreachable must not crash an Executor mid-job.
    void sendHeartbeat(config, `${transition}/heartbeat`, claim, attempt).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);

  try {
    // Raced against the signal too, so the deadline holds even for work that
    // does not stop when asked.
    const preview = await untilAborted(
      processor.process({
        locator: claim.locator,
        directory,
        fetch: config.fetch,
        allowedSourceOrigins: claim.allowedSourceOrigins,
        signal: attempt.signal,
      }),
      attempt.signal,
    );
    const put = await config.s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: claim.outputKey,
        Body: preview.bytes,
        ContentType: "image/webp",
      }),
      { abortSignal: attempt.signal },
    );
    uploaded = true;
    objectEtag = put.ETag;
    const completed = await control(config, `${transition}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        processingToken: claim.processingToken,
        masterKey: claim.outputKey,
        width: preview.width,
        height: preview.height,
        format: "webp",
        objectEtag: objectEtag ?? "",
      }),
    });
    if (!completed.ok) {
      if (completed.status === 409) {
        await deleteUploadedAttempt(config, claim.outputKey, objectEtag);
        uploaded = false;
        await emit("executor.stale_completion", "error", claim, startedAt, "stale_attempt");
        return "processed";
      }
      throw new Error(`Control completion failed with ${completed.status}`);
    }
    await emit("executor.completed", "info", claim, startedAt);
    return "processed";
  } catch (error) {
    // Control has already moved the job on: a fail report would be refused,
    // and an upload stays put as after any ambiguous completion.
    if (attempt.signal.reason instanceof StaleAttempt) {
      await emit("executor.failed", "error", claim, startedAt, "stale_attempt");
      return "processed";
    }

    const failure: ExecutorFailure =
      attempt.signal.reason instanceof AttemptDeadlineExceeded
        ? { retryable: true }
        : processor.failure(error);
    await emit("executor.failed", "error", claim, startedAt, failure.code);
    let failed: Response;
    try {
      failed = await control(config, `${transition}/fail`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ processingToken: claim.processingToken, ...failure }),
      });
    } catch {
      // Prefer an orphaned object over deleting a master Control may already own.
      return "processed";
    }
    if (uploaded && failed.status === 204)
      await deleteUploadedAttempt(config, claim.outputKey, objectEtag);
    return "processed";
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    await rm(directory, { recursive: true, force: true });
  }
}

async function deleteUploadedAttempt(
  config: ExecutorConfig,
  key: string,
  objectEtag: string | undefined,
): Promise<void> {
  if (objectEtag === undefined || objectEtag === "") return;
  try {
    await config.s3.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
        IfMatch: objectEtag,
      }),
    );
  } catch {
    // Precondition failure means a newer object owns the key; leave it alone.
  }
}

/** Writes one sanitized event as a single JSON line, so Railway keeps it whole and reads its level. */
function emitExecutorEvent(level: "info" | "error", event: OperationalEvent): void {
  console[level](JSON.stringify({ level, ...sanitizeOperationalEvent(event) }));
}

async function emit(
  event: "executor.completed" | "executor.failed" | "executor.stale_completion",
  level: "info" | "error",
  claim: ExecutorClaim,
  startedAt: number,
  failureCode?: JobFailureCode | "stale_attempt",
) {
  const fields: OperationalEventFields = {
    kind: claim.kind,
    executionCycle: claim.executionCycle,
    attemptNumber: claim.attemptNumber,
    durationMs: Date.now() - startedAt,
    outcome: event === "executor.completed" ? "ready" : "failed",
  };
  if (failureCode !== undefined) fields.failureCode = failureCode;
  emitExecutorEvent(
    level,
    await operationalEvent({
      event,
      spaceId: claim.spaceId,
      sourceId: claim.sourceId,
      processingToken: claim.processingToken,
      fields,
    }),
  );
}

export type ExecutorRunner = (config: ExecutorConfig) => Promise<ExecutorInvocationResult>;

function credentialDigest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorizedWake(header: string | undefined, expectedToken: string): boolean {
  if (expectedToken.length < 32 || header === undefined || !header.startsWith("Bearer "))
    return false;
  return timingSafeEqual(
    credentialDigest(header.slice("Bearer ".length)),
    credentialDigest(expectedToken),
  );
}

export interface Executor {
  /** Health, favicons, and the authenticated `POST /internal/v1/run-once` wake. */
  app: Hono;
  /**
   * Runs one invocation as the process starts, so the wake that started a
   * sleeping Executor still gets a job done even if Railway refused that
   * request while the container booted. Resolves once it settles; a no-op
   * without configuration.
   */
  boot(): Promise<void>;
}

function emitInvocationFailure(kind: PreviewKind): void {
  emitExecutorEvent("error", {
    event: "executor.failed",
    kind,
    outcome: "failed",
    failureCode: "service_unavailable",
  });
}

/**
 * The Executor process: invocations run one at a time (ADR 0004), whether a
 * wake or the boot invocation started them. A wake that arrives during
 * another invocation waits for it. If that invocation processed a job, the
 * wake answers `processed` at once and Control wakes again; if it found
 * nothing or failed, the wake runs an invocation of its own, since its job
 * may have been submitted after that claim.
 */
export function createExecutor(
  kind: PreviewKind,
  config?: ExecutorConfig,
  run?: ExecutorRunner,
): Executor {
  const app = new Hono();
  let inFlight: Promise<ExecutorInvocationResult> | undefined;

  const invoke = async (
    configured: ExecutorConfig,
    runner: ExecutorRunner,
  ): Promise<ExecutorInvocationResult> => {
    while (inFlight !== undefined) {
      const settled = await inFlight.then(
        (result): ExecutorInvocationResult | "failed" => result,
        () => "failed",
      );
      if (settled === "processed") return "processed";
    }

    const current = runner(configured).finally(() => {
      inFlight = undefined;
    });
    inFlight = current;

    return current;
  };

  app.get("/favicon.svg", faviconSvgResponse);
  app.get("/favicon.ico", faviconIcoResponse);
  app.get("/healthz", (context) => context.json({ ok: true, service: `executor-${kind}` }));
  app.post(EXECUTOR_WAKE_ROUTE, async (context) => {
    if (
      config === undefined ||
      run === undefined ||
      !authorizedWake(context.req.header("authorization"), config.roleToken)
    )
      return context.json({ error: { code: "unauthorized" } }, 401);

    try {
      return context.json({ result: await invoke(config, run) } satisfies ExecutorWakeReply);
    } catch {
      emitInvocationFailure(kind);
      return context.json({ error: { code: "service_unavailable" } }, 503);
    }
  });

  return {
    app,
    async boot() {
      if (config === undefined || run === undefined) return;

      try {
        await invoke(config, run);
      } catch {
        emitInvocationFailure(kind);
      }
    },
  };
}

export function createExecutorConfigFromEnv(): ExecutorConfig | undefined {
  const {
    CONTROL_BASE_URL: controlBaseUrl,
    EXECUTOR_ROLE_TOKEN: roleToken,
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
    S3_BUCKET: bucket,
  } = process.env;
  if (
    controlBaseUrl === undefined ||
    roleToken === undefined ||
    endpoint === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    bucket === undefined
  ) {
    return undefined;
  }
  return {
    controlBaseUrl,
    roleToken,
    bucket,
    fetch: globalThis.fetch,
    s3: new S3Client({
      region: process.env.S3_REGION ?? "auto",
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

/** Serves the Executor and starts its boot invocation. */
export function serveExecutor(
  kind: PreviewKind,
  executor: Executor,
): { close(callback?: (error?: Error) => void): void } {
  const portValue = process.env.PORT ?? "3000";
  if (!/^[1-9]\d*$/.test(portValue)) throw new Error("PORT must be a positive integer");
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("PORT is out of range");
  const server = serve({ fetch: executor.app.fetch, port });
  function shutdown() {
    server.close((error) => {
      if (error) {
        emitExecutorEvent("error", {
          event: "executor.failed",
          kind,
          outcome: "failed",
          failureCode: "service_unavailable",
        });
        process.exitCode = 1;
      }
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  void executor.boot();
  return server;
}
