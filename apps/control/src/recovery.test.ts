import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlLogger } from "./logging.js";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import type { PostgresPreviewJobLifecycle } from "./preview-job-lifecycle.js";
import { runRecoverySweep } from "./recovery.js";

const start = new Date("2026-07-12T00:00:00Z");
const NOOP_LOGGER: ControlLogger = { emit() {}, async shutdown() {} };

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

  it("dispatches one wake for every runnable job and separates executor kinds", async () => {
    await submit(lifecycle, "video-1", "video");
    await submit(lifecycle, "video-2", "video");
    await submit(lifecycle, "pdf-1", "pdf");
    const dispatch = vi.fn(async () => {});

    const result = await runRecoverySweep({
      logger: NOOP_LOGGER,
      lifecycle,
      now: () => start,
      dispatch,
    });

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
    await lifecycle.claim("video", start);
    const afterLease = new Date(start.getTime() + 16 * 60 * 1_000);
    const dispatch = vi.fn(async () => {
      throw new Error("executor unavailable");
    });
    const emit = vi.fn<ControlLogger["emit"]>();

    const result = await runRecoverySweep({
      logger: { emit, async shutdown() {} },
      lifecycle,
      now: () => afterLease,
      dispatch,
    });

    expect(result).toEqual({
      expiredPendingJobs: 0,
      recoveredLeases: 1,
      dispatchedJobs: 0,
      dispatchFailures: 1,
    });
    expect(
      await lifecycle.read({ spaceId: "example-private", sourceId: "video-1", kind: "video" }),
    ).toMatchObject({ status: "pending" });
    expect(emit).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ event: "control.dispatch.failed" }),
    );
  });
});
