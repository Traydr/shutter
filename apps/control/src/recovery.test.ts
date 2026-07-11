import { describe, expect, it, vi } from "vitest";
import { InMemoryJobStore } from "./job-store.js";
import { runRecoverySweep } from "./recovery.js";

const start = new Date("2026-07-12T00:00:00Z");

async function submit(store: InMemoryJobStore, sourceId: string, kind: "video" | "pdf") {
  await store.submit(
    {
      spaceId: "pane-view",
      sourceId,
      kind,
      sourceCapability: "opaque-capability",
      capabilityExpiresAt: new Date(start.getTime() + 86_400_000),
    },
    start,
  );
}

describe("job recovery sweep", () => {
  it("dispatches one wake for every runnable job and separates executor kinds", async () => {
    const store = new InMemoryJobStore();
    await submit(store, "video-1", "video");
    await submit(store, "video-2", "video");
    await submit(store, "pdf-1", "pdf");
    const dispatch = vi.fn(async () => {});

    const result = await runRecoverySweep({ store, now: () => start, dispatch });

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
    const store = new InMemoryJobStore();
    await submit(store, "video-1", "video");
    await store.claim("video", start);
    const afterLease = new Date(start.getTime() + 16 * 60 * 1_000);
    const dispatch = vi.fn(async () => {
      throw new Error("executor unavailable");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runRecoverySweep({ store, now: () => afterLease, dispatch });

    expect(result).toEqual({
      expiredPendingJobs: 0,
      recoveredLeases: 1,
      dispatchedJobs: 0,
      dispatchFailures: 1,
    });
    expect(
      await store.get({ spaceId: "pane-view", sourceId: "video-1", kind: "video" }),
    ).toMatchObject({ status: "pending" });
    log.mockRestore();
  });
});
