import { operationalEvent, type PreviewKind } from "@shutter/protocol";
import type { ExecutorDrains } from "./executor-dispatch.js";
import type { ControlLogger } from "./logging.js";
import type { PreviewJobLifecycle } from "./preview-job-lifecycle.js";

export const RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;
export const RECOVERY_BATCH_SIZE = 100;
/** A retry timer fires this long after `next_attempt_at`, so the claim's clock is past it. */
export const RETRY_TIMER_SLACK_MS = 1_000;

/** The longest delay `setTimeout` honors; a longer one would fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const PREVIEW_KINDS = ["video", "pdf"] as const satisfies readonly PreviewKind[];

export interface RecoveryRuntime {
  logger: ControlLogger;
  lifecycle: Pick<PreviewJobLifecycle, "maintain" | "nextAttemptAt">;
  now(): Date;
  drains: Pick<ExecutorDrains, "drain">;
}

export interface RecoveryResult {
  expiredPendingJobs: number;
  recoveredLeases: number;
  runnableJobs: number;
  /** Every kind with a runnable job; a drain was requested for each. */
  drainedKinds: readonly PreviewKind[];
}

/**
 * How the Job API and the sweep ask for drains. A request for a kind that is
 * already draining joins that drain, and a drain logs its own failure.
 */
export interface DispatchRequests {
  /** Requests a drain of `kind` now. */
  dispatch(kind: PreviewKind): void;
  /**
   * Requests a drain of `kind` once `at` has passed. Each kind keeps one
   * timer, for its earliest known retry; after that drain the timer is re-read
   * from Postgres.
   */
  scheduleDispatch(kind: PreviewKind, at: Date): void;
}

/**
 * When Control wakes Executors: at once for a submission, at
 * `next_attempt_at` for a retry, and from a periodic sweep that expires
 * overdue jobs, recovers expired leases, drains every kind with runnable work,
 * and re-reads each kind's next retry from Postgres, whatever was missed.
 */
export interface JobDispatch extends DispatchRequests {
  /** Runs the first sweep now, and the next one an interval after each finishes. */
  start(): void;
  /** Clears the sweep and every retry timer. Drains in flight are `ExecutorDrains.close`'s. */
  stop(): void;
}

/**
 * One sweep. It requests drains without waiting for them, so a long drain
 * never delays the next sweep's lease recovery and expiry, and one kind's
 * failing Executor never holds back the other kind.
 */
export async function runRecoverySweep(
  runtime: RecoveryRuntime,
  dispatch: DispatchRequests,
): Promise<RecoveryResult> {
  const now = runtime.now();
  const maintenance = await runtime.lifecycle.maintain(now, RECOVERY_BATCH_SIZE);
  const drainedKinds = PREVIEW_KINDS.filter((kind) => maintenance.runnableKinds.includes(kind));

  for (const kind of drainedKinds) dispatch.dispatch(kind);

  for (const kind of PREVIEW_KINDS) {
    const nextAttemptAt = await runtime.lifecycle.nextAttemptAt(kind, now);

    if (nextAttemptAt !== undefined) dispatch.scheduleDispatch(kind, nextAttemptAt);
  }

  const result = {
    expiredPendingJobs: maintenance.expiredPendingJobs,
    recoveredLeases: maintenance.recoveredLeases,
    runnableJobs: maintenance.runnableKinds.length,
    drainedKinds,
  };
  const count = result.runnableJobs + result.recoveredLeases + result.expiredPendingJobs;

  if (count > 0) {
    runtime.logger.emit(
      "info",
      await operationalEvent({ event: "control.recovery.completed", fields: { count } }),
    );
  }

  return result;
}

export function createJobDispatch(
  runtime: RecoveryRuntime,
  intervalMs = RECOVERY_INTERVAL_MS,
): JobDispatch {
  let stopped = false;
  let sweepTimer: NodeJS.Timeout | undefined;
  const retryTimers = new Map<PreviewKind, { dueAt: number; timer: NodeJS.Timeout }>();

  const reportFailure = () => {
    runtime.logger.emit("error", {
      event: "control.recovery.failed",
      outcome: "failed",
      failureCode: "service_unavailable",
    });
  };

  const dispatch = (kind: PreviewKind) => {
    if (stopped) return;

    void runtime.drains.drain(kind);
  };

  const rereadRetry = async (kind: PreviewKind) => {
    if (stopped) return;

    try {
      const nextAttemptAt = await runtime.lifecycle.nextAttemptAt(kind, runtime.now());

      if (nextAttemptAt !== undefined) scheduleDispatch(kind, nextAttemptAt);
    } catch {
      // The next sweep reads it again.
      reportFailure();
    }
  };

  const scheduleDispatch = (kind: PreviewKind, at: Date) => {
    if (stopped) return;

    const dueAt = at.getTime() + RETRY_TIMER_SLACK_MS;
    const armed = retryTimers.get(kind);

    if (armed !== undefined && armed.dueAt <= dueAt) return;

    if (armed !== undefined) clearTimeout(armed.timer);

    const delay = Math.min(Math.max(0, dueAt - runtime.now().getTime()), MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      retryTimers.delete(kind);

      if (stopped) return;

      void runtime.drains.drain(kind).then(() => rereadRetry(kind));
    }, delay);
    timer.unref();
    retryTimers.set(kind, { dueAt, timer });
  };

  const scheduleSweep = () => {
    if (stopped) return;

    sweepTimer = setTimeout(() => void sweep(), intervalMs);
    sweepTimer.unref();
  };

  const sweep = async () => {
    try {
      await runRecoverySweep(runtime, { dispatch, scheduleDispatch });
    } catch {
      reportFailure();
    } finally {
      scheduleSweep();
    }
  };

  return {
    dispatch,
    scheduleDispatch,
    start() {
      void sweep();
    },
    stop() {
      stopped = true;
      if (sweepTimer !== undefined) clearTimeout(sweepTimer);
      for (const { timer } of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
    },
  };
}
