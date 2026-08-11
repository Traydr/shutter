import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  type ExecutorClaim,
  emitOperationalEvent,
  type JobFailureCode,
  operationalEvent,
  type RenditionKind,
  type SourceOriginRule,
} from "@shutter/protocol";
import { parseExecutorClaim } from "@shutter/protocol/jobs";
import { getSpacePolicy } from "@shutter/space-config";
import { Config, ConfigProvider, Data, Effect, Layer, Option, Semaphore } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export {
  type CommandRunner,
  downloadSource,
  ProcessingFailure,
  parseFfprobeDimensions,
  probeWebpDimensions,
  runCommand,
} from "./media.js";

export const EXECUTOR_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

export interface ExecutorConfig {
  controlBaseUrl: string;
  roleToken: string;
  bucket: string;
  s3: S3Client;
  fetch: typeof globalThis.fetch;
}

export interface ProcessedMasterPreview {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface ExecutorProcessor {
  kind: RenditionKind;
  process(
    locator: string,
    directory: string,
    fetch: typeof globalThis.fetch,
    allowedSourceOrigins: readonly SourceOriginRule[],
  ): Effect.Effect<ProcessedMasterPreview, unknown>;
  failure(error: unknown): { retryable: boolean; code?: JobFailureCode };
}

class ExecutorExternalFailure extends Data.TaggedError("ExecutorExternalFailure")<{
  readonly operation: "control" | "storage";
  readonly cause?: unknown;
}> {}

function control(
  config: ExecutorConfig,
  path: string,
  init: RequestInit,
): Effect.Effect<Response, ExecutorExternalFailure> {
  return Effect.suspend(() => {
    let url: URL;
    try {
      url = new URL(path, config.controlBaseUrl);
    } catch (error) {
      return Effect.die(error);
    }
    return Effect.tryPromise({
      try: (signal) =>
        config.fetch(url, {
          ...init,
          signal,
          headers: { authorization: `Bearer ${config.roleToken}`, ...init.headers },
        }),
      catch: (cause) => new ExecutorExternalFailure({ operation: "control", cause }),
    });
  });
}

function storageRequest<A>(request: () => Promise<A>): Effect.Effect<A, ExecutorExternalFailure> {
  return Effect.tryPromise({
    try: request,
    catch: (cause) => new ExecutorExternalFailure({ operation: "storage", cause }),
  });
}

function responseJson(response: Response): Effect.Effect<unknown, ExecutorExternalFailure> {
  return Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new ExecutorExternalFailure({ operation: "control", cause }),
  });
}

function unexpectedResponse(operation: "control" | "storage"): ExecutorExternalFailure {
  return new ExecutorExternalFailure({ operation });
}

export function runExecutorOnce(
  config: ExecutorConfig,
  processor: ExecutorProcessor,
): Effect.Effect<"idle" | "processed", unknown> {
  return Effect.gen(function* () {
    const claimed = yield* control(config, `/internal/v1/executors/${processor.kind}/claim`, {
      method: "POST",
    });
    if (claimed.status === 204) return "idle" as const;
    if (!claimed.ok) return yield* Effect.fail(unexpectedResponse("control"));

    const claim = yield* responseJson(claimed).pipe(Effect.flatMap(parseExecutorClaim));
    if (claim.kind !== processor.kind) {
      return yield* Effect.die(new Error("Control returned the wrong Rendition kind"));
    }

    const startedAt = Date.now();
    yield* emitClaimed(claim);

    const policy = getSpacePolicy(claim.spaceId);
    if (policy === undefined) {
      return yield* Effect.die(new Error(`Unknown Shutter Space ${claim.spaceId}`));
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), `shutter-${processor.kind}-`))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        let uploaded = false;
        let objectEtag: string | undefined;
        const transition = `/internal/v1/executors/${processor.kind}/jobs/${encodeURIComponent(claim.spaceId)}/${encodeURIComponent(claim.sourceId)}`;

        // This outbound POST is also the Railway Serverless keep-alive during a long
        // transcode. Railway ignores inbound traffic when deciding whether to sleep.
        yield* heartbeatLoop(config, claim, transition, startedAt).pipe(Effect.forkScoped);

        const attempt = Effect.gen(function* () {
          const preview = yield* processor
            .process(claim.locator, directory, config.fetch, policy.allowedSourceOrigins)
            .pipe(Effect.timeout(EXECUTOR_ATTEMPT_TIMEOUT_MS));

          const put = yield* storageRequest(() =>
            config.s3.send(
              new PutObjectCommand({
                Bucket: config.bucket,
                Key: claim.outputKey,
                Body: preview.bytes,
                ContentType: "image/webp",
              }),
            ),
          );
          uploaded = true;
          objectEtag = put.ETag;

          const completed = yield* control(config, `${transition}/complete`, {
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
              yield* deleteUploadedAttempt(config, claim.outputKey, objectEtag);
              uploaded = false;
              yield* emit("executor.stale_completion", "error", claim, startedAt, "stale_attempt");
              return "processed" as const;
            }
            return yield* Effect.fail(unexpectedResponse("control"));
          }

          yield* emit("executor.completed", "info", claim, startedAt);
          return "processed" as const;
        });

        return yield* attempt.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const failure = processor.failure(error);
              yield* emit("executor.failed", "error", claim, startedAt, failure.code);
              const failed = yield* control(config, `${transition}/fail`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ processingToken: claim.processingToken, ...failure }),
              }).pipe(Effect.catch(() => Effect.succeed(undefined)));
              if (failed === undefined) {
                // Prefer an orphaned object over deleting a master Control may already own.
                return "processed" as const;
              }
              if (uploaded && failed.status === 204) {
                yield* deleteUploadedAttempt(config, claim.outputKey, objectEtag);
              }
              return "processed" as const;
            }),
          ),
        );
      }),
    );
  });
}

function heartbeatLoop(
  config: ExecutorConfig,
  claim: ExecutorClaim,
  transition: string,
  startedAt: number,
): Effect.Effect<never> {
  const heartbeat = Effect.sleep(HEARTBEAT_INTERVAL_MS).pipe(
    Effect.andThen(
      control(config, `${transition}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ processingToken: claim.processingToken }),
      }),
    ),
    Effect.flatMap((response) =>
      response.ok ? Effect.void : Effect.fail(unexpectedResponse("control")),
    ),
    Effect.catch(() => emit("executor.failed", "error", claim, startedAt, "service_unavailable")),
  );
  return Effect.forever(heartbeat);
}

function deleteUploadedAttempt(
  config: ExecutorConfig,
  key: string,
  objectEtag: string | undefined,
): Effect.Effect<void> {
  if (objectEtag === undefined || objectEtag === "") return Effect.void;
  return storageRequest(() =>
    config.s3.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
        IfMatch: objectEtag,
      }),
    ),
  ).pipe(
    Effect.asVoid,
    // Precondition failure means a newer object owns the key; leave it alone.
    Effect.catch(() => Effect.void),
  );
}

function emitClaimed(claim: ExecutorClaim): Effect.Effect<void> {
  return operationalEvent({
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
  }).pipe(
    Effect.tap((event) => Effect.sync(() => emitOperationalEvent("info", event))),
    Effect.asVoid,
  );
}

function emit(
  event: "executor.completed" | "executor.failed" | "executor.stale_completion",
  level: "info" | "error",
  claim: ExecutorClaim,
  startedAt: number,
  failureCode?: JobFailureCode | "service_unavailable" | "stale_attempt",
): Effect.Effect<void> {
  return operationalEvent({
    event,
    spaceId: claim.spaceId,
    sourceId: claim.sourceId,
    processingToken: claim.processingToken,
    fields: {
      kind: claim.kind,
      executionCycle: claim.executionCycle,
      attemptNumber: claim.attemptNumber,
      durationMs: Date.now() - startedAt,
      outcome: event === "executor.completed" ? "ready" : "failed",
      ...(failureCode === undefined ? {} : { failureCode }),
    },
  }).pipe(
    Effect.tap((operational) => Effect.sync(() => emitOperationalEvent(level, operational))),
    Effect.asVoid,
  );
}

export type ExecutorRunner = (
  config: ExecutorConfig,
) => Effect.Effect<"idle" | "processed", unknown>;

function credentialDigest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorizedWake(header: string | undefined, expectedToken: string): boolean {
  if (expectedToken.length < 32 || header === undefined || !header.startsWith("Bearer ")) {
    return false;
  }
  return timingSafeEqual(
    credentialDigest(header.slice("Bearer ".length)),
    credentialDigest(expectedToken),
  );
}

function executorFailureResponse(
  kind: RenditionKind,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.sync(() => {
    emitOperationalEvent("error", {
      event: "executor.failed",
      kind,
      outcome: "failed",
      failureCode: "service_unavailable",
    });
    return HttpServerResponse.jsonUnsafe(
      { error: { code: "service_unavailable" } },
      { status: 503 },
    );
  });
}

export function createExecutorRoutes(
  kind: RenditionKind,
  config?: ExecutorConfig,
  run?: ExecutorRunner,
) {
  const semaphore = Semaphore.makeUnsafe(1);
  const wake = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (
      config === undefined ||
      run === undefined ||
      !authorizedWake(request.headers.authorization, config.roleToken)
    ) {
      return HttpServerResponse.jsonUnsafe({ error: { code: "unauthorized" } }, { status: 401 });
    }

    const result = yield* semaphore.withPermitsIfAvailable(1)(
      Effect.suspend(() => run(config)).pipe(
        Effect.map((value) => HttpServerResponse.jsonUnsafe({ result: value })),
        Effect.catchCause(() => executorFailureResponse(kind)),
      ),
    );
    return Option.getOrElse(result, () =>
      HttpServerResponse.jsonUnsafe({ result: "busy" }, { status: 202 }),
    );
  });

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/healthz",
      HttpServerResponse.jsonUnsafe({ ok: true, service: `executor-${kind}` }),
    ),
    HttpRouter.add("POST", "/internal/v1/run-once", wake),
  );
}

export function createExecutorApp(
  kind: RenditionKind,
  config?: ExecutorConfig,
  run?: ExecutorRunner,
) {
  const web = HttpRouter.toWebHandler(createExecutorRoutes(kind, config, run), {
    disableLogger: true,
  });
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return web.handler(input instanceof Request ? input : new Request(input, init));
    },
    dispose: web.dispose,
  };
}

const executorEnvironment = Config.unwrap({
  controlBaseUrl: Config.option(Config.string("CONTROL_BASE_URL")),
  roleToken: Config.option(Config.string("EXECUTOR_ROLE_TOKEN")),
  endpoint: Config.option(Config.string("S3_ENDPOINT")),
  accessKeyId: Config.option(Config.string("S3_ACCESS_KEY_ID")),
  secretAccessKey: Config.option(Config.string("S3_SECRET_ACCESS_KEY")),
  bucket: Config.option(Config.string("S3_BUCKET")),
  region: Config.string("S3_REGION").pipe(Config.withDefault("auto")),
});

export function loadExecutorConfig(
  runtimeEnv: Record<string, string | undefined>,
): Effect.Effect<ExecutorConfig | undefined, Config.ConfigError> {
  return executorEnvironment
    .parse(
      ConfigProvider.fromEnv({
        env: Object.fromEntries(
          Object.entries(runtimeEnv).filter(
            (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "",
          ),
        ),
      }),
    )
    .pipe(
      Effect.map((environment) =>
        Option.all({
          controlBaseUrl: environment.controlBaseUrl,
          roleToken: environment.roleToken,
          endpoint: environment.endpoint,
          accessKeyId: environment.accessKeyId,
          secretAccessKey: environment.secretAccessKey,
          bucket: environment.bucket,
        }).pipe(
          Option.map((configured) => ({
            controlBaseUrl: configured.controlBaseUrl,
            roleToken: configured.roleToken,
            bucket: configured.bucket,
            fetch: globalThis.fetch,
            s3: new S3Client({
              region: environment.region,
              endpoint: configured.endpoint,
              forcePathStyle: true,
              credentials: {
                accessKeyId: configured.accessKeyId,
                secretAccessKey: configured.secretAccessKey,
              },
            }),
          })),
          Option.getOrUndefined,
        ),
      ),
    );
}

export function createExecutorConfigFromEnv(): Effect.Effect<
  ExecutorConfig | undefined,
  Config.ConfigError
> {
  return loadExecutorConfig(process.env);
}

export function serveExecutorApp(
  routes: Layer.Layer<never, Config.ConfigError, HttpRouter.HttpRouter>,
): void {
  const server = NodeHttpServer.layerConfig(createServer, {
    port: Config.port("PORT").pipe(Config.withDefault(3_000)),
  });
  const http = HttpRouter.serve(routes).pipe(Layer.provide(server));
  NodeRuntime.runMain(Layer.launch(http));
}
