import type { RenditionKind } from "@shutter/protocol";
import { Context, Data, Effect, Layer, Schedule, Semaphore } from "effect";
import { ControlConfig } from "./env/server.js";
import { ControlLogger } from "./logging.js";

export const EXECUTOR_WAKE_TIMEOUT_MS = 11 * 60 * 1_000;
const COLD_START_RETRIES = 2;

export class ExecutorWakeError extends Data.TaggedError("ExecutorWakeError")<{
  readonly reason: "not_configured" | "request_failed" | "timeout" | "unexpected_status";
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export interface ExecutorDispatchShape {
  dispatch(kind: RenditionKind): Effect.Effect<void, ExecutorWakeError>;
}

export class ExecutorDispatch extends Context.Service<ExecutorDispatch, ExecutorDispatchShape>()(
  "@shutter/control/ExecutorDispatch",
) {
  static readonly layer = Layer.effect(
    ExecutorDispatch,
    Effect.gen(function* () {
      const config = yield* ControlConfig;
      const logger = yield* ControlLogger;
      const semaphores = {
        video: yield* Semaphore.make(1),
        pdf: yield* Semaphore.make(1),
      } satisfies Record<RenditionKind, Semaphore.Semaphore>;

      return ExecutorDispatch.of({
        dispatch(kind) {
          const baseUrl =
            kind === "video" ? config.videoExecutorBaseUrl : config.pdfExecutorBaseUrl;
          const token = kind === "video" ? config.videoExecutorToken : config.pdfExecutorToken;
          if (baseUrl === undefined || token === undefined) {
            return Effect.fail(new ExecutorWakeError({ reason: "not_configured" }));
          }
          return semaphores[kind].withPermit(
            Effect.gen(function* () {
              yield* logger.emit("info", {
                event: "control.executor.delegated",
                kind,
                outcome: "accepted",
              });
              yield* sendExecutorWake({
                baseUrl,
                fetch: globalThis.fetch,
                timeoutMs: EXECUTOR_WAKE_TIMEOUT_MS,
                token,
              });
              yield* logger.emit("info", {
                event: "control.executor.delegated",
                kind,
                outcome: "ready",
              });
            }),
          );
        },
      });
    }),
  );
}

export function createSerializedExecutorDispatch(
  wake: (kind: RenditionKind) => Effect.Effect<void, ExecutorWakeError>,
): Effect.Effect<ExecutorDispatchShape> {
  return Effect.gen(function* () {
    const semaphores = {
      video: yield* Semaphore.make(1),
      pdf: yield* Semaphore.make(1),
    } satisfies Record<RenditionKind, Semaphore.Semaphore>;
    return ExecutorDispatch.of({
      dispatch: (kind) => semaphores[kind].withPermit(wake(kind)),
    });
  });
}

export function sendExecutorWake({
  baseUrl,
  fetch,
  timeoutMs,
  token,
}: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  token: string;
}): Effect.Effect<void, ExecutorWakeError> {
  const attempt = Effect.tryPromise({
    try: (signal) =>
      fetch(new URL("/internal/v1/run-once", baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal,
      }),
    catch: (cause) => new ExecutorWakeError({ reason: "request_failed", cause }),
  }).pipe(
    Effect.timeout(timeoutMs),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new ExecutorWakeError({ reason: "timeout" })),
    ),
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.void
        : Effect.fail(
            new ExecutorWakeError({ reason: "unexpected_status", status: response.status }),
          ),
    ),
  );

  return attempt.pipe(
    Effect.retry({
      schedule: Schedule.exponential("200 millis"),
      times: COLD_START_RETRIES,
      while: (error) => error.reason === "unexpected_status" && error.status === 502,
    }),
  );
}
