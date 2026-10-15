import type { PreviewKind } from "@shutter/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrainOutcome } from "./executor-dispatch.js";
import type { ControlLogger } from "./logging.js";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import type { MaintenanceResult, PostgresPreviewJobLifecycle } from "./preview-job-lifecycle.js";
import {
  createJobDispatch,
  RECOVERY_INTERVAL_MS,
  RETRY_TIMER_SLACK_MS,
  type RecoveryRuntime,
  runRecoverySweep,
} from "./recovery.js";

const start = new Date("2026-07-12T00:00:00Z");
const NOOP_LOGGER: ControlLogger = { emit() {}, async shutdown() {} };
const IDLE: DrainOutcome = { outcome: "idle", wakes: 1 };

async function submit(
  lifecycle: PostgresPreviewJobLifecycle,
  sourceId: string,
  kind: "video" | "pdf",
) {
  await lifecycle.submit(
    {
      spaceId: "example-private",
      sourceId,
      kind,
      sourceCapability: "opaque-capability",
      capabilityExpiresAt: new Date(start.getTime() + 86_400_000),
    },
    start,
  );
}

function recordingDispatch() {
  const dispatched: PreviewKind[] = [];
  const scheduled: { kind: PreviewKind; at: Date }[] = [];

  return {
    dispatched,
    scheduled,
    dispatch: {
      dispatch: (kind: PreviewKind) => {
        dispatched.push(kind);
      },
      scheduleDispatch: (kind: PreviewKind, at: Date) => {
        scheduled.push({ kind, at });
      },
    },
  };
}

describe("job recovery sweep", () => {
  let test: PostgresTestLifecycle;
  let lifecycle: PostgresPreviewJobLifecycle;

  beforeAll(async () => {
    test = await createPostgresTestLifecycle();
    lifecycle = test.lifecycle;
  });

  afterAll(async () => test.close());

  beforeEach(async () => {
    await test.pool.query("truncate table preview_jobs");
  });

  function runtime(now: Date): RecoveryRuntime {
    return { logger: NOOP_LOGGER, lifecycle, now: () => now, drains: { drain: async () => IDLE } };
  }

  it("requests one drain per kind with runnable work, however many jobs it has", async () => {
    await submit(lifecycle, "video-1", "video");
    await submit(lifecycle, "video-2", "video");
    await submit(lifecycle, "pdf-1", "pdf");
    const { dispatched, scheduled, dispatch } = recordingDispatch();

    const result = await runRecoverySweep(runtime(start), dispatch);

    expect(result).toEqual({
      expiredPendingJobs: 0,
      recoveredLeases: 0,
      runnableJobs: 3,
      drainedKinds: ["video", "pdf"],
    });
    expect(dispatched).toEqual(["video", "pdf"]);
    expect(scheduled).toEqual([]);
  });

  it("recovers an expired lease and drains its kind", async () => {
    await submit(lifecycle, "video-1", "video");
    await lifecycle.claim("video", start);
    const afterLease = new Date(start.getTime() + 16 * 60 * 1_000);
    const { dispatched, dispatch } = recordingDispatch();

    const result = await runRecoverySweep(runtime(afterLease), dispatch);

    expect(result).toEqual({
      expiredPendingJobs: 0,
      recoveredLeases: 1,
      runnableJobs: 1,
      drainedKinds: ["video"],
    });
    expect(dispatched).toEqual(["video"]);
    expect(
      await lifecycle.read({ spaceId: "example-private", sourceId: "video-1", kind: "video" }),
    ).toMatchObject({ status: "pending" });
  });

  it("schedules each kind's next retry from Postgres instead of draining early", async () => {
    await submit(lifecycle, "video-1", "video");
    const claim = await lifecycle.claim("video", start);
    if (claim === undefined) throw new Error("expected a claim");
    await lifecycle.fail(claim, claim.processingToken, { retryable: true }, start);
    const { dispatched, scheduled, dispatch } = recordingDispatch();

    await runRecoverySweep(runtime(new Date(start.getTime() + 1_000)), dispatch);

    expect(dispatched).toEqual([]);
    expect(scheduled).toEqual([{ kind: "video", at: new Date(start.getTime() + 60_000) }]);
  });
});

/**
 * Pending jobs as the sweep and the retry timer see them: each kind's
 * `next_attempt_at` values. A drain claims every due job of its kind, and a
 * job listed in `failAgainAfterMs` fails again and is rescheduled.
 */
function fakeJobs(now: () => Date) {
  const pending: { kind: PreviewKind; nextAttemptAt: number; failAgainAfterMs?: number }[] = [];
  const drained: { kind: PreviewKind; at: number }[] = [];
  const lifecycle: RecoveryRuntime["lifecycle"] = {
    async maintain(at): Promise<MaintenanceResult> {
      return {
        expiredPendingJobs: 0,
        recoveredLeases: 0,
        runnableKinds: pending.flatMap((job) =>
          job.nextAttemptAt <= at.getTime() ? [job.kind] : [],
        ),
      };
    },
    async nextAttemptAt(kind, after) {
      const times = pending.flatMap((job) =>
        job.kind === kind && job.nextAttemptAt > after.getTime() ? [job.nextAttemptAt] : [],
      );

      return times.length === 0 ? undefined : new Date(Math.min(...times));
    },
  };
  const drain = async (kind: PreviewKind): Promise<DrainOutcome> => {
    const at = now().getTime();
    drained.push({ kind, at });
    for (const [index, job] of [...pending.entries()].reverse()) {
      if (job.kind !== kind || job.nextAttemptAt > at) continue;
      if (job.failAgainAfterMs === undefined) pending.splice(index, 1);
      else job.nextAttemptAt = at + job.failAgainAfterMs;
    }

    return IDLE;
  };

  return { pending, drained, lifecycle, drains: { drain } };
}

describe("job dispatch timers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: start });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const now = () => new Date(Date.now());

  it("wakes a kind when its retry comes due, then reads the next one", async () => {
    const jobs = fakeJobs(now);
    jobs.pending.push({
      kind: "pdf",
      nextAttemptAt: start.getTime() + 60_000,
      failAgainAfterMs: 300_000,
    });
    const dispatch = createJobDispatch({ ...jobs, logger: NOOP_LOGGER, now });

    dispatch.start();
    await vi.advanceTimersByTimeAsync(60_000 + RETRY_TIMER_SLACK_MS);
    expect(jobs.drained).toEqual([{ kind: "pdf", at: start.getTime() + 61_000 }]);

    // That retry failed again, five minutes out; the timer is re-read after the drain.
    await vi.advanceTimersByTimeAsync(300_000 + RETRY_TIMER_SLACK_MS);
    expect(jobs.drained).toEqual([
      { kind: "pdf", at: start.getTime() + 61_000 },
      { kind: "pdf", at: start.getTime() + 362_000 },
    ]);
    dispatch.stop();
  });

  it("keeps one timer per kind, at its earliest retry", async () => {
    const jobs = fakeJobs(now);
    const dispatch = createJobDispatch({ ...jobs, logger: NOOP_LOGGER, now });

    dispatch.scheduleDispatch("video", new Date(start.getTime() + 120_000));
    dispatch.scheduleDispatch("video", new Date(start.getTime() + 30_000));
    dispatch.scheduleDispatch("video", new Date(start.getTime() + 90_000));
    dispatch.scheduleDispatch("pdf", new Date(start.getTime() + 45_000));
    await vi.advanceTimersByTimeAsync(200_000);

    expect(jobs.drained).toEqual([
      { kind: "video", at: start.getTime() + 31_000 },
      { kind: "pdf", at: start.getTime() + 46_000 },
    ]);
    dispatch.stop();
  });

  it("drains runnable work on the first sweep and sweeps again on schedule without waiting for drains", async () => {
    const jobs = fakeJobs(now);
    jobs.pending.push({ kind: "video", nextAttemptAt: start.getTime() });
    const maintain = vi.spyOn(jobs.lifecycle, "maintain");
    const drain = vi.fn(() => new Promise<DrainOutcome>(() => {}));
    const dispatch = createJobDispatch({ ...jobs, drains: { drain }, logger: NOOP_LOGGER, now });

    dispatch.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(drain.mock.calls).toEqual([["video"]]);

    await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
    expect(maintain).toHaveBeenCalledTimes(2);
    expect(drain.mock.calls).toEqual([["video"], ["video"]]);
    dispatch.stop();
  });

  it("logs a failed sweep and still sweeps again", async () => {
    const emit = vi.fn<ControlLogger["emit"]>();
    const jobs = fakeJobs(now);
    const maintain = vi
      .spyOn(jobs.lifecycle, "maintain")
      .mockRejectedValueOnce(new Error("database unavailable"));
    const dispatch = createJobDispatch({
      ...jobs,
      logger: { emit, async shutdown() {} },
      now,
    });

    dispatch.start();
    await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);

    expect(maintain).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls).toEqual([
      [
        "error",
        { event: "control.recovery.failed", outcome: "failed", failureCode: "service_unavailable" },
      ],
    ]);
    dispatch.stop();
  });

  it("clears the sweep and every retry timer on stop", async () => {
    const jobs = fakeJobs(now);
    const maintain = vi.spyOn(jobs.lifecycle, "maintain");
    const dispatch = createJobDispatch({ ...jobs, logger: NOOP_LOGGER, now });

    dispatch.start();
    await vi.advanceTimersByTimeAsync(0);
    dispatch.scheduleDispatch("video", new Date(start.getTime() + 60_000));
    dispatch.stop();
    dispatch.dispatch("pdf");
    dispatch.scheduleDispatch("pdf", new Date(start.getTime() + 60_000));
    await vi.advanceTimersByTimeAsync(2 * RECOVERY_INTERVAL_MS);

    expect(maintain).toHaveBeenCalledTimes(1);
    expect(jobs.drained).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
