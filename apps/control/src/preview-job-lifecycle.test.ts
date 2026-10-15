import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import {
  CLAIM_RELEASE_DELAY_SECONDS,
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

  it("releases a claim it could not serve without spending the attempt", async () => {
    await lifecycle.submit(input, start);
    const claim = await lifecycle.claim("video", start);
    expect(claim).toMatchObject({ attemptNumber: 1 });
    if (claim === undefined) throw new Error("expected a claim");

    await expect(lifecycle.release(identity, "stale-token", start)).resolves.toEqual({
      outcome: "stale_attempt",
    });
    const releasedAt = new Date(start.getTime() + 1_000);
    const claimableAt = new Date(releasedAt.getTime() + CLAIM_RELEASE_DELAY_SECONDS * 1_000);
    await expect(lifecycle.release(identity, claim.processingToken, releasedAt)).resolves.toEqual({
      outcome: "released",
      nextAttemptAt: claimableAt,
    });
    await expect(lifecycle.release(identity, claim.processingToken, releasedAt)).resolves.toEqual({
      outcome: "stale_attempt",
    });
    expect(await lifecycle.read(identity)).toMatchObject({ status: "pending", attemptNumber: 0 });

    await expect(lifecycle.claim("video", releasedAt)).resolves.toBeUndefined();
    await expect(lifecycle.claim("video", claimableAt)).resolves.toMatchObject({
      attemptNumber: 1,
    });
  });

  it("finds each kind's next retry among its pending jobs", async () => {
    await lifecycle.submit(input, start);
    await lifecycle.submit({ ...input, sourceId: "source-2" }, start);
    await lifecycle.submit({ ...input, sourceId: "source-3", kind: "pdf" }, start);
    for (const kind of ["video", "video", "pdf"] as const) {
      const claim = await lifecycle.claim(kind, start);
      if (claim === undefined) throw new Error("expected a claim");
      const failedAt = new Date(start.getTime() + (claim.sourceId === "source-2" ? 5_000 : 0));
      await expect(
        lifecycle.fail(claim, claim.processingToken, { retryable: true }, failedAt),
      ).resolves.toEqual({
        outcome: "retry_scheduled",
        nextAttemptAt: new Date(failedAt.getTime() + (RETRY_DELAYS_SECONDS[0] ?? 0) * 1_000),
      });
    }

    await expect(lifecycle.nextAttemptAt("video", start)).resolves.toEqual(
      new Date(start.getTime() + 60_000),
    );
    await expect(
      lifecycle.nextAttemptAt("video", new Date(start.getTime() + 60_000)),
    ).resolves.toEqual(new Date(start.getTime() + 65_000));
    await expect(
      lifecycle.nextAttemptAt("video", new Date(start.getTime() + 65_000)),
    ).resolves.toBeUndefined();
    await expect(lifecycle.nextAttemptAt("pdf", start)).resolves.toEqual(
      new Date(start.getTime() + 60_000),
    );
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

  it("gives a resolver source the full retry window and exhausts it without a capability", async () => {
    await lifecycle.submit(identity, start);
    const row = await test.pool.query<{
      retry_deadline_at: Date;
      source_capability: string | null;
    }>("select retry_deadline_at, source_capability from preview_jobs");
    expect(row.rows[0]?.source_capability).toBeNull();
    expect(row.rows[0]?.retry_deadline_at).toEqual(
      new Date(start.getTime() + JOB_RETRY_WINDOW_SECONDS * 1_000),
    );
    const claimed = await lifecycle.claim("video", start);
    expect(claimed).toMatchObject({ sourceId: "source-1", attemptNumber: 1 });
    expect(claimed).not.toHaveProperty("sourceCapability");

    await test.pool.query("truncate table preview_jobs");
    await lifecycle.submit(identity, start);
    const past = new Date(start.getTime() + JOB_RETRY_WINDOW_SECONDS * 1_000 + 1);
    await lifecycle.maintain(past, 100);
    await expect(lifecycle.read(identity)).resolves.toMatchObject({
      representation: { status: "failed", failure: { code: "attempts_exhausted" } },
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
