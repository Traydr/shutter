import { operationalEvent, type RenditionKind } from "@shutter/protocol";
import { Effect, Layer, Schedule } from "effect";
import { ExecutorDispatch, type ExecutorDispatchShape } from "./executor-dispatch.js";
import { ControlLogger, type ControlLoggerShape } from "./logging.js";
import {
  RenditionJobLifecycle,
  type RenditionJobLifecycleShape,
} from "./rendition-job-lifecycle.js";

export const RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;
export const RECOVERY_BATCH_SIZE = 100;

export interface RecoveryRuntime {
  logger: ControlLoggerShape;
  lifecycle: RenditionJobLifecycleShape;
  now(): Date;
  dispatch: ExecutorDispatchShape["dispatch"];
}

export interface RecoveryResult {
  expiredPendingJobs: number;
  recoveredLeases: number;
  dispatchedJobs: number;
  dispatchFailures: number;
}

function dispatchKind(
  kind: RenditionKind,
  count: number,
  dispatch: RecoveryRuntime["dispatch"],
  logger: ControlLoggerShape,
) {
  return Effect.gen(function* () {
    let dispatched = 0;
    for (let index = 0; index < count; index += 1) {
      const succeeded = yield* dispatch(kind).pipe(
        Effect.as(true),
        Effect.catch(() =>
          logger
            .emit("error", {
              event: "control.dispatch.failed",
              kind,
              outcome: "failed",
              failureCode: "service_unavailable",
            })
            .pipe(Effect.as(false)),
        ),
      );
      if (!succeeded) return { dispatched, failed: 1 };
      dispatched += 1;
    }
    return { dispatched, failed: 0 };
  });
}

export function runRecoverySweep(runtime: RecoveryRuntime) {
  return Effect.gen(function* () {
    const now = runtime.now();
    const maintenance = yield* runtime.lifecycle.maintain(now, RECOVERY_BATCH_SIZE);
    const counts: Record<RenditionKind, number> = { video: 0, pdf: 0 };
    for (const kind of maintenance.runnableKinds) counts[kind] += 1;

    const [video, pdf] = yield* Effect.all(
      [
        dispatchKind("video", counts.video, runtime.dispatch, runtime.logger),
        dispatchKind("pdf", counts.pdf, runtime.dispatch, runtime.logger),
      ],
      { concurrency: 2 },
    );
    const result = {
      expiredPendingJobs: maintenance.expiredPendingJobs,
      recoveredLeases: maintenance.recoveredLeases,
      dispatchedJobs: video.dispatched + pdf.dispatched,
      dispatchFailures: video.failed + pdf.failed,
    };
    if (
      result.expiredPendingJobs > 0 ||
      result.recoveredLeases > 0 ||
      result.dispatchedJobs > 0 ||
      result.dispatchFailures > 0
    ) {
      const event = yield* operationalEvent({
        event: "control.recovery.completed",
        fields: {
          count: result.dispatchedJobs + result.recoveredLeases + result.expiredPendingJobs,
        },
      });
      yield* runtime.logger.emit("info", event);
    }
    return result;
  });
}

export function recoveryLayer(intervalMs = RECOVERY_INTERVAL_MS) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const logger = yield* ControlLogger;
      const lifecycle = yield* RenditionJobLifecycle;
      const dispatch = yield* ExecutorDispatch;
      const sweep = runRecoverySweep({
        logger,
        lifecycle,
        now: () => new Date(),
        dispatch: dispatch.dispatch,
      }).pipe(
        Effect.catchCause(() =>
          logger.emit("error", {
            event: "control.recovery.failed",
            outcome: "failed",
            failureCode: "service_unavailable",
          }),
        ),
        Effect.schedule(Schedule.spaced(intervalMs)),
      );
      yield* Effect.forkScoped(sweep);
    }),
  );
}

export const RecoveryLive = recoveryLayer();
