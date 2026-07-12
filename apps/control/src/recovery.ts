import { emitOperationalEvent, operationalEvent, type RenditionKind } from "@shutter/protocol";
import type { JobStore } from "./job-store.js";

export const RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;
export const RECOVERY_BATCH_SIZE = 100;

export interface RecoveryRuntime {
  store: JobStore;
  now(): Date;
  dispatch(kind: RenditionKind): Promise<void>;
}

export interface RecoveryResult {
  expiredPendingJobs: number;
  recoveredLeases: number;
  dispatchedJobs: number;
  dispatchFailures: number;
}

async function dispatchKind(
  kind: RenditionKind,
  count: number,
  dispatch: RecoveryRuntime["dispatch"],
): Promise<{ dispatched: number; failed: number }> {
  let dispatched = 0;
  for (let index = 0; index < count; index += 1) {
    try {
      await dispatch(kind);
      dispatched += 1;
    } catch {
      emitOperationalEvent("error", {
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
  const expiredPendingJobs = await runtime.store.expirePendingJobs(now);
  const recoveredLeases = await runtime.store.recoverExpiredLeases(now);
  const runnableKinds = await runtime.store.runnableJobKinds(now, RECOVERY_BATCH_SIZE);
  const counts: Record<RenditionKind, number> = { video: 0, pdf: 0 };
  for (const kind of runnableKinds) counts[kind] += 1;

  const [video, pdf] = await Promise.all([
    dispatchKind("video", counts.video, runtime.dispatch),
    dispatchKind("pdf", counts.pdf, runtime.dispatch),
  ]);
  const result = {
    expiredPendingJobs,
    recoveredLeases,
    dispatchedJobs: video.dispatched + pdf.dispatched,
    dispatchFailures: video.failed + pdf.failed,
  };
  if (
    result.expiredPendingJobs > 0 ||
    result.recoveredLeases > 0 ||
    result.dispatchedJobs > 0 ||
    result.dispatchFailures > 0
  ) {
    emitOperationalEvent(
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
      emitOperationalEvent("error", {
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
