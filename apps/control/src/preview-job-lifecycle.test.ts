import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import {
  JOB_RETRY_WINDOW_SECONDS,
  MAX_ATTEMPTS,
  type PostgresPreviewJobLifecycle,
  PROCESSING_LEASE_SECONDS,
  postgresSourceLockKey,
  RETRY_DELAYS_SECONDS,
} from "./preview-job-lifecycle.js";

const start = new Date("2026-01-01T00:00:00.000Z");
const identity = { spaceId: "example-private", sourceId: "source-1", kind: "video" as const };
const input = {
  ...identity,
  sourceCapability: "opaque-capability",
  capabilityExpiresAt: new Date(start.getTime() + 86_400_000),
};
const master = {
  masterKey: "masters/v1/example-private/source-1/video.webp",
  width: 1920,
  height: 1080,
  format: "webp" as const,
  objectEtag: "etag",
};

describe("Postgres Preview Job lifecycle", () => {
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

  it("builds source-lock keys without forbidden NUL bytes or tuple collisions", () => {
    expect(postgresSourceLockKey("a", "b\u0000c")).not.toContain("\u0000");
    expect(postgresSourceLockKey("a", "b\u0000c")).not.toBe(postgresSourceLockKey("a\u0000b", "c"));
  });

  it("converges concurrent submissions and rejects stale completion tokens", async () => {
    const [left, right] = await Promise.all([
      lifecycle.submit(input, start),
      lifecycle.submit({ ...input, sourceCapability: "replacement" }, start),
    ]);
    expect([left.disposition, right.disposition].sort()).toEqual(["created", "existing"]);

    const claim = await lifecycle.claim("video", start);
    expect(claim).toMatchObject({ attemptNumber: 1, executionCycle: 0 });
    if (claim === undefined) throw new Error("expected a claim");
    await expect(
      lifecycle.heartbeat(identity, claim.processingToken, new Date(start.getTime() + 30_000)),
    ).resolves.toEqual({ outcome: "accepted" });

    await expect(lifecycle.complete(identity, "stale-token", master, start)).resolves.toEqual({
      outcome: "stale_attempt",
    });
    await expect(
      lifecycle.complete(identity, claim.processingToken, master, start),
    ).resolves.toEqual({ outcome: "accepted" });
    await expect(
      lifecycle.heartbeat(identity, claim.processingToken, new Date(start.getTime() + 60_000)),
    ).resolves.toEqual({ outcome: "stale_attempt" });
    expect(await lifecycle.read(identity)).toMatchObject({
      status: "ready",
      representation: { status: "ready", master: { sourceId: "source-1", kind: "video" } },
    });
  });

  it("claims one Preview Job only once across concurrent connections", async () => {
    await lifecycle.submit(input, start);
    const claims = await Promise.all([
      lifecycle.claim("video", start),
      lifecycle.claim("video", start),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
  });

  it("owns retry scheduling, terminal failure, and reactivation", async () => {
    await lifecycle.submit(input, start);
    let now = start;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const claim = await lifecycle.claim("video", now);
      expect(claim).toMatchObject({ attemptNumber: attempt });
      if (claim === undefined) throw new Error("expected a claim");
      const failure = await lifecycle.fail(
        identity,
        claim.processingToken,
        { retryable: true },
        now,
      );
      expect(failure.outcome).toBe(attempt === MAX_ATTEMPTS ? "terminal" : "retry_scheduled");
      const delay = RETRY_DELAYS_SECONDS[attempt - 1];
      if (delay !== undefined) now = new Date(now.getTime() + delay * 1_000);
    }
    expect(await lifecycle.read(identity)).toMatchObject({
      status: "failed",
      representation: {
        status: "failed",
        failure: { code: "attempts_exhausted", action: "retry" },
      },
    });

    const reactivated = await lifecycle.submit(input, new Date(now.getTime() + 1_000));
    expect(reactivated).toMatchObject({
      disposition: "reactivated",
      job: { status: "pending", executionCycle: 1, attemptNumber: 0 },
    });
  });

  it("maintains expiry and recovered leases in one ordered operation", async () => {
    await lifecycle.submit(
      { ...input, capabilityExpiresAt: new Date(start.getTime() + 60_000) },
      start,
    );
    const expiredAt = new Date(start.getTime() + 61_000);
    await expect(lifecycle.maintain(expiredAt, 100)).resolves.toEqual({
      expiredPendingJobs: 1,
      recoveredLeases: 0,
      runnableKinds: [],
    });

    await test.pool.query("truncate table preview_jobs");
    await lifecycle.submit(input, start);
    await lifecycle.claim("video", start);
    const recoveredAt = new Date(start.getTime() + PROCESSING_LEASE_SECONDS * 1_000 + 1);
    await expect(lifecycle.maintain(recoveredAt, 100)).resolves.toEqual({
      expiredPendingJobs: 0,
      recoveredLeases: 1,
      runnableKinds: ["video"],
    });
  });

  it("bounds retry deadlines by lifecycle policy", async () => {
    await lifecycle.submit(
      { ...input, capabilityExpiresAt: new Date(start.getTime() + 48 * 60 * 60 * 1_000) },
      start,
    );
    const row = await test.pool.query<{ retry_deadline_at: Date }>(
      "select retry_deadline_at from preview_jobs",
    );
    expect(row.rows[0]?.retry_deadline_at).toEqual(
      new Date(start.getTime() + JOB_RETRY_WINDOW_SECONDS * 1_000),
    );
  });

  it("commits Source Purge invalidation before cleanup and never resurrects jobs", async () => {
    await lifecycle.submit(input, start);
    const claim = await lifecycle.claim("video", start);
    if (claim === undefined) throw new Error("expected a claim");

    await expect(
      lifecycle.withInvalidatedSource(identity, async () => {
        expect(await lifecycle.read(identity)).toBeUndefined();
        throw new Error("edge purge unavailable");
      }),
    ).rejects.toThrow("edge purge unavailable");

    expect(await lifecycle.read(identity)).toBeUndefined();
    await expect(
      lifecycle.complete(identity, claim.processingToken, master, start),
    ).resolves.toEqual({ outcome: "stale_attempt" });
    await expect(lifecycle.withInvalidatedSource(identity, async () => "retried")).resolves.toEqual(
      { invalidatedJobs: 0, value: "retried" },
    );
  });

  it("holds source exclusion across cleanup without blocking unrelated sources", async () => {
    await lifecycle.submit(input, start);
    const claim = await lifecycle.claim("video", start);
    if (claim === undefined) throw new Error("expected a claim");

    let releaseCleanup = () => {};
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupStarted = () => {};
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const purge = lifecycle.withInvalidatedSource(identity, async () => {
      cleanupStarted();
      await cleanupGate;
    });
    await started;

    let completionSettled = false;
    const completion = lifecycle
      .complete(identity, claim.processingToken, master, start)
      .finally(() => {
        completionSettled = true;
      });
    let submissionSettled = false;
    const submission = lifecycle.submit(input, start).finally(() => {
      submissionSettled = true;
    });
    await lifecycle.submit({ ...input, sourceId: "unrelated-source" }, start);
    expect(completionSettled).toBe(false);
    expect(submissionSettled).toBe(false);

    releaseCleanup();
    await purge;
    await expect(completion).resolves.toEqual({ outcome: "stale_attempt" });
    await expect(submission).resolves.toMatchObject({ disposition: "created" });
  });
});
