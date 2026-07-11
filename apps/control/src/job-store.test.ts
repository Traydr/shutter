import { describe, expect, it } from "vitest";
import { InMemoryJobStore, jobRepresentation, MAX_ATTEMPTS } from "./job-store.js";

const identity = { spaceId: "pane-view", sourceId: "source-1", kind: "video" as const };
const start = new Date("2026-07-11T00:00:00Z");

describe("rendition job store", () => {
  it("converges duplicate submissions and rejects stale completion tokens", async () => {
    const store = new InMemoryJobStore();
    const input = {
      ...identity,
      sourceCapability: "opaque-capability",
      capabilityExpiresAt: new Date(start.getTime() + 86_400_000),
    };
    const first = await store.submit(input, start);
    const duplicate = await store.submit({ ...input, sourceCapability: "renewed" }, start);
    expect(first.executionCycle).toBe(0);
    expect(duplicate.sourceCapability).toBe("opaque-capability");

    const claim = await store.claim("video", start);
    expect(claim?.attemptNumber).toBe(1);
    expect(
      await store.complete(
        identity,
        "stale",
        {
          masterKey: "masters/v1/test.webp",
          width: 1920,
          height: 1080,
          format: "webp",
          objectEtag: "etag",
        },
        start,
      ),
    ).toBe(false);
  });

  it("retries with the fixed schedule and permits a new execution cycle", async () => {
    const store = new InMemoryJobStore();
    const input = {
      ...identity,
      sourceCapability: "opaque-capability",
      capabilityExpiresAt: new Date(start.getTime() + 86_400_000),
    };
    await store.submit(input, start);
    let now = start;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const claim = await store.claim("video", now);
      expect(claim?.attemptNumber).toBe(attempt);
      await store.fail(identity, claim?.processingToken ?? "", { retryable: true }, now);
      const current = await store.get(identity);
      if (attempt < MAX_ATTEMPTS) {
        expect(current?.status).toBe("pending");
        now = current?.nextAttemptAt ?? now;
      }
    }
    const failed = await store.get(identity);
    expect(failed).toBeDefined();
    if (failed === undefined) throw new Error("expected failed job");
    expect(jobRepresentation(failed)).toEqual({
      status: "failed",
      failure: { code: "attempts_exhausted", action: "retry" },
    });
    const reactivated = await store.submit(input, new Date(now.getTime() + 1_000));
    expect(reactivated.executionCycle).toBe(1);
    expect(reactivated.attemptNumber).toBe(0);
  });

  it("recovers an expired lease without allowing the stale attempt to complete", async () => {
    const store = new InMemoryJobStore();
    await store.submit(
      {
        ...identity,
        sourceCapability: "opaque-capability",
        capabilityExpiresAt: new Date(start.getTime() + 86_400_000),
      },
      start,
    );
    const claim = await store.claim("video", start);
    const afterLease = new Date(start.getTime() + 16 * 60 * 1_000);
    expect(await store.recoverExpiredLeases(afterLease)).toBe(1);
    expect(await store.heartbeat(identity, claim?.processingToken ?? "", afterLease)).toBe(false);
    expect((await store.get(identity))?.status).toBe("pending");
  });

  it("finds due work and expires pending jobs after their retry window", async () => {
    const store = new InMemoryJobStore();
    await store.submit(
      {
        ...identity,
        sourceCapability: "opaque-capability",
        capabilityExpiresAt: new Date(start.getTime() + 60_000),
      },
      start,
    );

    expect(await store.runnableJobKinds(start, 100)).toEqual(["video"]);
    const expiredAt = new Date(start.getTime() + 61_000);
    expect(await store.expirePendingJobs(expiredAt)).toBe(1);
    expect(await store.runnableJobKinds(expiredAt, 100)).toEqual([]);
    expect(await store.get(identity)).toMatchObject({
      status: "failed",
      failureCode: "source_expired",
    });
  });
});
