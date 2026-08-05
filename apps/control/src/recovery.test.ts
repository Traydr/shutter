import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlLoggerShape } from "./logging.js";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import { runRecoverySweep } from "./recovery.js";
import type { RenditionJobLifecycleShape } from "./rendition-job-lifecycle.js";

const start = new Date("2026-07-12T00:00:00Z");
const NOOP_LOGGER: ControlLoggerShape = { emit: () => Effect.void };

async function submit(
  lifecycle: RenditionJobLifecycleShape,
  sourceId: string,
  kind: "video" | "pdf",
) {
  await Effect.runPromise(
    lifecycle.submit(
      {
        spaceId: "pane-view",
        sourceId,
        kind,
        sourceCapability: "opaque-capability",
        capabilityExpiresAt: new Date(start.getTime() + 86_400_000),
      },
      start,
    ),
  );
}

describe("job recovery sweep", () => {
  let test: PostgresTestLifecycle;
  let lifecycle: RenditionJobLifecycleShape;

  beforeAll(async () => {
    test = await createPostgresTestLifecycle();
    lifecycle = test.lifecycle;
  });

  afterAll(async () => test.close());

  beforeEach(async () => {
    await test.pool.query("truncate table rendition_jobs");
  });

  it("dispatches one wake for every runnable job and separates executor kinds", async () => {
    await submit(lifecycle, "video-1", "video");
    await submit(lifecycle, "video-2", "video");
    await submit(lifecycle, "pdf-1", "pdf");
    const dispatch = vi.fn(() => Effect.void);

    const result = await Effect.runPromise(
      runRecoverySweep({ logger: NOOP_LOGGER, lifecycle, now: () => start, dispatch }),
    );

    expect(result).toEqual({
      expiredPendingJobs: 0,
      recoveredLeases: 0,
      dispatchedJobs: 3,
      dispatchFailures: 0,
    });
    expect(dispatch.mock.calls.filter(([kind]) => kind === "video")).toHaveLength(2);
    expect(dispatch.mock.calls.filter(([kind]) => kind === "pdf")).toHaveLength(1);
  });

  it("recovers expired leases before redispatch and contains dispatch failure", async () => {
    await submit(lifecycle, "video-1", "video");
    await Effect.runPromise(lifecycle.claim("video", start));
    const afterLease = new Date(start.getTime() + 16 * 60 * 1_000);
    const dispatch = vi.fn(() => Effect.fail({ reason: "executor unavailable" } as never));
    const emit = vi.fn<ControlLoggerShape["emit"]>(() => Effect.void);

    const result = await Effect.runPromise(
      runRecoverySweep({ logger: { emit }, lifecycle, now: () => afterLease, dispatch }),
    );

    expect(result).toEqual({
      expiredPendingJobs: 0,
      recoveredLeases: 1,
      dispatchedJobs: 0,
      dispatchFailures: 1,
    });
    expect(
      await Effect.runPromise(
        lifecycle.read({ spaceId: "pane-view", sourceId: "video-1", kind: "video" }),
      ),
    ).toMatchObject({ status: "pending" });
    expect(emit).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ event: "control.dispatch.failed" }),
    );
  });
});
