import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import {
  JOB_RETRY_WINDOW_SECONDS,
  MAX_ATTEMPTS,
  PROCESSING_LEASE_SECONDS,
  postgresSourceLockKey,
  RETRY_DELAYS_SECONDS,
  type RenditionJobLifecycleShape,
} from "./rendition-job-lifecycle.js";

const start = new Date("2026-01-01T00:00:00.000Z");
const identity = { spaceId: "pane-view", sourceId: "source-1", kind: "video" as const };
const input = {
  ...identity,
  sourceCapability: "opaque-capability",
  capabilityExpiresAt: new Date(start.getTime() + 86_400_000),
};
const master = {
  masterKey: "masters/v1/pane-view/source-1/video.webp",
  width: 1920,
  height: 1080,
  format: "webp" as const,
  objectEtag: "etag",
};

describe("Postgres Rendition Job lifecycle", () => {
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

  it("builds source-lock keys without forbidden NUL bytes or tuple collisions", () => {
    expect(postgresSourceLockKey("a", "b\u0000c")).not.toContain("\u0000");
    expect(postgresSourceLockKey("a", "b\u0000c")).not.toBe(postgresSourceLockKey("a\u0000b", "c"));
  });

  it.effect("converges concurrent submissions and rejects stale completion tokens", () =>
    Effect.gen(function* () {
      const [left, right] = yield* Effect.all(
        [
          lifecycle.submit(input, start),
          lifecycle.submit({ ...input, sourceCapability: "replacement" }, start),
        ],
        { concurrency: "unbounded" },
      );
      expect([left.disposition, right.disposition].sort()).toEqual(["created", "existing"]);

      const claim = yield* lifecycle.claim("video", start);
      expect(claim).toMatchObject({ attemptNumber: 1, executionCycle: 0 });
      if (claim === undefined) throw new Error("expected a claim");
      expect(
        yield* lifecycle.heartbeat(
          identity,
          claim.processingToken,
          new Date(start.getTime() + 30_000),
        ),
      ).toEqual({ outcome: "accepted" });

      expect(yield* lifecycle.complete(identity, "stale-token", master, start)).toEqual({
        outcome: "stale_attempt",
      });
      expect(yield* lifecycle.complete(identity, claim.processingToken, master, start)).toEqual({
        outcome: "accepted",
      });
      expect(
        yield* lifecycle.heartbeat(
          identity,
          claim.processingToken,
          new Date(start.getTime() + 60_000),
        ),
      ).toEqual({ outcome: "stale_attempt" });
      expect(yield* lifecycle.read(identity)).toMatchObject({
        status: "ready",
        representation: { status: "ready", master: { sourceId: "source-1", kind: "video" } },
      });
    }),
  );

  it.effect("claims one Rendition Job only once across concurrent connections", () =>
    Effect.gen(function* () {
      yield* lifecycle.submit(input, start);
      const claims = yield* Effect.all(
        [lifecycle.claim("video", start), lifecycle.claim("video", start)],
        { concurrency: "unbounded" },
      );
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    }),
  );

  it.effect("owns retry scheduling, terminal failure, and reactivation", () =>
    Effect.gen(function* () {
      yield* lifecycle.submit(input, start);
      let now = start;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const claim = yield* lifecycle.claim("video", now);
        expect(claim).toMatchObject({ attemptNumber: attempt });
        if (claim === undefined) throw new Error("expected a claim");
        const failure = yield* lifecycle.fail(
          identity,
          claim.processingToken,
          { retryable: true },
          now,
        );
        expect(failure.outcome).toBe(attempt === MAX_ATTEMPTS ? "terminal" : "retry_scheduled");
        const delay = RETRY_DELAYS_SECONDS[attempt - 1];
        if (delay !== undefined) now = new Date(now.getTime() + delay * 1_000);
      }
      expect(yield* lifecycle.read(identity)).toMatchObject({
        status: "failed",
        representation: {
          status: "failed",
          failure: { code: "attempts_exhausted", action: "retry" },
        },
      });

      const reactivated = yield* lifecycle.submit(input, new Date(now.getTime() + 1_000));
      expect(reactivated).toMatchObject({
        disposition: "reactivated",
        job: { status: "pending", executionCycle: 1, attemptNumber: 0 },
      });
    }),
  );

  it.effect("maintains expiry and recovered leases in one ordered operation", () =>
    Effect.gen(function* () {
      yield* lifecycle.submit(
        { ...input, capabilityExpiresAt: new Date(start.getTime() + 60_000) },
        start,
      );
      const expiredAt = new Date(start.getTime() + 61_000);
      expect(yield* lifecycle.maintain(expiredAt, 100)).toEqual({
        expiredPendingJobs: 1,
        recoveredLeases: 0,
        runnableKinds: [],
      });

      yield* Effect.promise(() => test.pool.query("truncate table rendition_jobs"));
      yield* lifecycle.submit(input, start);
      yield* lifecycle.claim("video", start);
      const recoveredAt = new Date(start.getTime() + PROCESSING_LEASE_SECONDS * 1_000 + 1);
      expect(yield* lifecycle.maintain(recoveredAt, 100)).toEqual({
        expiredPendingJobs: 0,
        recoveredLeases: 1,
        runnableKinds: ["video"],
      });
    }),
  );

  it.effect("bounds retry deadlines by lifecycle policy", () =>
    Effect.gen(function* () {
      yield* lifecycle.submit(
        { ...input, capabilityExpiresAt: new Date(start.getTime() + 48 * 60 * 60 * 1_000) },
        start,
      );
      const row = yield* Effect.promise(() =>
        test.pool.query<{ retry_deadline_at: Date }>(
          "select retry_deadline_at from rendition_jobs",
        ),
      );
      expect(row.rows[0]?.retry_deadline_at).toEqual(
        new Date(start.getTime() + JOB_RETRY_WINDOW_SECONDS * 1_000),
      );
    }),
  );

  it.effect("commits Source Purge invalidation before cleanup and never resurrects jobs", () =>
    Effect.gen(function* () {
      yield* lifecycle.submit(input, start);
      const claim = yield* lifecycle.claim("video", start);
      if (claim === undefined) throw new Error("expected a claim");

      const error = yield* Effect.flip(
        lifecycle.withInvalidatedSource(
          identity,
          Effect.gen(function* () {
            expect(yield* lifecycle.read(identity)).toBeUndefined();
            return yield* Effect.fail(new Error("edge purge unavailable"));
          }),
        ),
      );
      expect(error.message).toBe("edge purge unavailable");

      expect(yield* lifecycle.read(identity)).toBeUndefined();
      expect(yield* lifecycle.complete(identity, claim.processingToken, master, start)).toEqual({
        outcome: "stale_attempt",
      });
      expect(yield* lifecycle.withInvalidatedSource(identity, Effect.succeed("retried"))).toEqual({
        invalidatedJobs: 0,
        value: "retried",
      });
    }),
  );

  it.effect("holds source exclusion across cleanup without blocking unrelated sources", () =>
    Effect.gen(function* () {
      yield* lifecycle.submit(input, start);
      const claim = yield* lifecycle.claim("video", start);
      if (claim === undefined) throw new Error("expected a claim");

      let releaseCleanup = () => {};
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      let cleanupStarted = () => {};
      const started = new Promise<void>((resolve) => {
        cleanupStarted = resolve;
      });
      const purge = yield* Effect.forkChild(
        lifecycle.withInvalidatedSource(
          identity,
          Effect.promise(async () => {
            cleanupStarted();
            await cleanupGate;
          }),
        ),
      );
      yield* Effect.promise(() => started);

      let completionSettled = false;
      const completion = yield* Effect.forkChild(
        lifecycle
          .complete(identity, claim.processingToken, master, start)
          .pipe(Effect.ensuring(Effect.sync(() => (completionSettled = true)))),
      );
      let submissionSettled = false;
      const submission = yield* Effect.forkChild(
        lifecycle
          .submit(input, start)
          .pipe(Effect.ensuring(Effect.sync(() => (submissionSettled = true)))),
      );
      yield* lifecycle.submit({ ...input, sourceId: "unrelated-source" }, start);
      expect(completionSettled).toBe(false);
      expect(submissionSettled).toBe(false);

      releaseCleanup();
      yield* Fiber.join(purge);
      expect(yield* Fiber.join(completion)).toEqual({ outcome: "stale_attempt" });
      expect(yield* Fiber.join(submission)).toMatchObject({ disposition: "created" });
    }),
  );
});
