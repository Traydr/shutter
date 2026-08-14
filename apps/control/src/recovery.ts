import { operationalEvent, type PreviewKind } from "@shutter/protocol";
import type { ControlLogger } from "./logging.js";
import type { PreviewJobLifecycle } from "./preview-job-lifecycle.js";

export const RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;
export const RECOVERY_BATCH_SIZE = 100;

export interface RecoveryRuntime {
  logger: ControlLogger;
  lifecycle: PreviewJobLifecycle;
  now(): Date;
  dispatch(kind: PreviewKind): Promise<void>;
}

export interface RecoveryResult {
  expiredPendingJobs: number;
  recoveredLeases: number;
  dispatchedJobs: number;
  dispatchFailures: number;
}

async function dispatchKind(
  kind: PreviewKind,
  count: number,
  dispatch: RecoveryRuntime["dispatch"],
  logger: ControlLogger,
): Promise<{ dispatched: number; failed: number }> {
  let dispatched = 0;
  for (let index = 0; index < count; index += 1) {
    try {
      await dispatch(kind);
      dispatched += 1;
    } catch {
      logger.emit("error", {
        event: "control.dispatch.failed",
        kind,
        outcome: "failed",
        failureCode: "service_unavailable",
      });
      return { dispatched, failed: 1 };
    }
  }
  return { dispatched, failed: 0 };
}

export async function runRecoverySweep(runtime: RecoveryRuntime): Promise<RecoveryResult> {
  const now = runtime.now();
  const maintenance = await runtime.lifecycle.maintain(now, RECOVERY_BATCH_SIZE);
  const counts: Record<PreviewKind, number> = { video: 0, pdf: 0 };
  for (const kind of maintenance.runnableKinds) counts[kind] += 1;

  const [video, pdf] = await Promise.all([
    dispatchKind("video", counts.video, runtime.dispatch, runtime.logger),
    dispatchKind("pdf", counts.pdf, runtime.dispatch, runtime.logger),
  ]);
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
    runtime.logger.emit(
      "info",
      await operationalEvent({
        event: "control.recovery.completed",
        fields: {
          count: result.dispatchedJobs + result.recoveredLeases + result.expiredPendingJobs,
        },
      }),
    );
  }
  return result;
}

export function startRecoverySweep(
  runtime: RecoveryRuntime,
  intervalMs = RECOVERY_INTERVAL_MS,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void sweep(), intervalMs);
    timer.unref();
  };
  const sweep = async () => {
    try {
      await runRecoverySweep(runtime);
    } catch {
      runtime.logger.emit("error", {
        event: "control.recovery.failed",
        outcome: "failed",
        failureCode: "service_unavailable",
      });
    } finally {
      schedule();
    }
  };

  void sweep();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
