import { type DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import {
  buildMasterPurgePrefix,
  buildR2CachePurgePrefix,
  buildSourceCacheTag,
} from "@shutter/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlLogger } from "./logging.js";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import type { PostgresPreviewJobLifecycle } from "./preview-job-lifecycle.js";
import {
  createSourcePurge,
  MAX_CONCURRENT_PURGES,
  PURGE_QUEUE_TIMEOUT_MS,
} from "./source-purge.js";

const EDGE_BASE = "https://edge.shutter.test";
const EDGE_TOKEN = "o".repeat(32);
const NOOP_LOGGER: ControlLogger = { emit() {}, async shutdown() {} };

type MediaStoreCommand = ListObjectsV2Command | DeleteObjectsCommand;

/** The part of an abort signal the tests read; the SDK types its own `AbortSignal`. */
interface StepSignal {
  readonly aborted: boolean;
}

/** The S3 `send` options the purge passes; it must bound every request. */
interface SendOptions {
  abortSignal?: StepSignal;
}

/** `send`'s second argument: the options, or the callback form the purge never uses. */
type SendArgument = SendOptions | ((error: Error | null, data?: never) => void);

describe("Source Purge", () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  function createPurge(fetch: typeof globalThis.fetch, send: S3Client["send"]) {
    return createSourcePurge({
      logger: NOOP_LOGGER,
      lifecycle,
      s3: { send },
      bucket: "shutter-media",
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "token",
      edgeBaseUrl: EDGE_BASE,
      edgeAuthToken: EDGE_TOKEN,
      fetch,
    });
  }

  const emptyStore = vi.fn(async (command: MediaStoreCommand) =>
    command instanceof ListObjectsV2Command ? { Contents: [], IsTruncated: false } : { Errors: [] },
  );

  it("deletes stored media and purges the shared Source Delivery cache tag", async () => {
    const identity = { spaceId: "example-public", sourceId: "source/one", kind: "video" as const };
    await lifecycle.submit(
      {
        ...identity,
        sourceCapability: "opaque",
        capabilityExpiresAt: new Date("2026-07-14T00:00:00Z"),
      },
      new Date("2026-07-13T00:00:00Z"),
    );
    const events: string[] = [];
    const cachePrefix = await buildR2CachePurgePrefix("public", "example-public", "source/one");
    const masterPrefix = await buildMasterPurgePrefix("example-public", "source/one");
    const listed: string[] = [];
    const signals: (StepSignal | undefined)[] = [];
    let cachePages = 0;
    const tag = await buildSourceCacheTag("example-public", "source/one");
    const send = vi.fn(async (command: MediaStoreCommand, options?: SendArgument) => {
      signals.push(options instanceof Function ? undefined : options?.abortSignal);
      if (command instanceof ListObjectsV2Command) {
        listed.push(command.input.Prefix ?? "");
        events.push("list");
        if (command.input.Prefix === cachePrefix) {
          cachePages += 1;
          return cachePages === 1
            ? {
                Contents: [{ Key: `${cachePrefix}one.webp` }],
                IsTruncated: true,
                NextContinuationToken: "next",
              }
            : { Contents: [{ Key: `${cachePrefix}two.webp` }], IsTruncated: false };
        }
        return { Contents: [{ Key: `${masterPrefix}video.webp` }], IsTruncated: false };
      }
      events.push("delete");
      return { Errors: [] };
    });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      const url = String(input);
      if (url.includes("/internal/v1/cache/purge")) {
        events.push("worker");
        expect(url).toBe(`${EDGE_BASE}/internal/v1/cache/purge`);
        expect(init?.headers).toMatchObject({
          authorization: `Bearer ${EDGE_TOKEN}`,
        });
        expect(JSON.parse(String(init?.body))).toEqual({ tags: [tag] });
        return new Response(null, { status: 204 });
      }
      events.push("tag");
      expect(JSON.parse(String(init?.body))).toEqual({ tags: [tag] });
      return Response.json({ success: true });
    });
    const sourcePurge = createPurge(fetch, send);

    await sourcePurge.purge({
      spaceId: "example-public",
      sourceId: "source/one",
      routeClass: "public",
    });
    expect(await lifecycle.read(identity)).toBeUndefined();
    // Only the Space's own route-class prefix can hold optimized images.
    expect([...listed].sort()).toEqual([cachePrefix, cachePrefix, masterPrefix].sort());
    expect(events.filter((event) => event === "delete")).toHaveLength(3);
    // Every R2 request finished before either edge purge started.
    expect(events.slice(0, -2).every((event) => event === "list" || event === "delete")).toBe(true);
    expect(events.slice(-2).sort()).toEqual(["tag", "worker"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/zones/zone-id/purge_cache",
      expect.objectContaining({ method: "POST" }),
    );
    // Every step carries its own timeout.
    expect(signals).toHaveLength(8);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
  });

  it("lists the private cache prefix for a private Space", async () => {
    const listed: string[] = [];
    const send = vi.fn(async (command: MediaStoreCommand) => {
      if (command instanceof ListObjectsV2Command) listed.push(command.input.Prefix ?? "");
      return emptyStore(command);
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ success: true }));

    await createPurge(fetch, send).purge({
      spaceId: "example-private",
      sourceId: "source",
      routeClass: "private",
    });

    expect([...listed].sort()).toEqual(
      [
        await buildR2CachePurgePrefix("private", "example-private", "source"),
        await buildMasterPurgePrefix("example-private", "source"),
      ].sort(),
    );
  });

  it("stops before later purge stages when an earlier stage fails", async () => {
    const deleteFetch = vi.fn();
    const deleteFails = createPurge(
      deleteFetch,
      vi.fn(async (command: MediaStoreCommand) =>
        command instanceof ListObjectsV2Command
          ? { Contents: [{ Key: "object" }], IsTruncated: false }
          : { Errors: [{ Key: "object", Code: "InternalError" }] },
      ),
    );
    await expect(
      deleteFails.purge({ spaceId: "example-private", sourceId: "source", routeClass: "private" }),
    ).rejects.toThrow("media store deletion failed");
    expect(deleteFetch).not.toHaveBeenCalled();

    const workerFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("api.cloudflare.com")
        ? Response.json({ success: true })
        : new Response(null, { status: 503 }),
    );
    const workerFails = createPurge(workerFetch, emptyStore);
    await expect(
      workerFails.purge({ spaceId: "example-private", sourceId: "source", routeClass: "private" }),
    ).rejects.toThrow("worker cache purge failed");
    // The two edge purges are independent, so one failing does not stop the other.
    expect(workerFetch).toHaveBeenCalledTimes(2);

    const zoneFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("api.cloudflare.com")
        ? Response.json({ success: false })
        : new Response(null, { status: 204 }),
    );
    await expect(
      createPurge(zoneFetch, emptyStore).purge({
        spaceId: "example-private",
        sourceId: "source",
        routeClass: "private",
      }),
    ).rejects.toThrow("cache tag purge failed");
    expect(zoneFetch).toHaveBeenCalledTimes(2);
  });

  it("retries safely after a Cloudflare failure", async () => {
    const identity = { spaceId: "example-private", sourceId: "source", kind: "pdf" as const };
    await lifecycle.submit(
      {
        ...identity,
        sourceCapability: "opaque",
        capabilityExpiresAt: new Date("2026-07-14T00:00:00Z"),
      },
      new Date("2026-07-13T00:00:00Z"),
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ success: false }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    const sourcePurge = createPurge(fetch, emptyStore);
    const source = {
      spaceId: "example-private",
      sourceId: "source",
      routeClass: "private",
    } as const;
    await expect(sourcePurge.purge(source)).rejects.toThrow("cache tag purge failed");
    expect(await lifecycle.read(identity)).toBeUndefined();
    await expect(sourcePurge.purge(source)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("runs a bounded number of purges at once so they cannot drain the pool", async () => {
    const releases: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const send = vi.fn(async (command: MediaStoreCommand) => {
      if (command instanceof ListObjectsV2Command && command.input.Prefix?.startsWith("masters/")) {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
      }
      return emptyStore(command);
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).includes("cloudflare")
        ? Response.json({ success: true })
        : new Response(null, { status: 204 }),
    );
    const sourcePurge = createPurge(fetch, send);
    const purges = ["one", "two", "three", "four"].map((sourceId) =>
      sourcePurge.purge({ spaceId: "example-public", sourceId, routeClass: "public" }),
    );

    await expect.poll(() => releases.length).toBe(MAX_CONCURRENT_PURGES);
    // The queued purges hold no connection while they wait.
    expect(test.pool.totalCount - test.pool.idleCount).toBe(MAX_CONCURRENT_PURGES);
    while (releases.length > 0 || running > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await expect(Promise.all(purges)).resolves.toHaveLength(4);
    expect(peak).toBe(MAX_CONCURRENT_PURGES);
  });

  it("fails a purge that waits too long for a slot with a retryable error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const releases: (() => void)[] = [];
    const send = vi.fn(async (command: MediaStoreCommand) => {
      if (command instanceof ListObjectsV2Command && command.input.Prefix?.startsWith("masters/")) {
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return emptyStore(command);
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).includes("cloudflare")
        ? Response.json({ success: true })
        : new Response(null, { status: 204 }),
    );
    const emit = vi.fn<ControlLogger["emit"]>();
    const sourcePurge = createSourcePurge({
      logger: { emit, async shutdown() {} },
      lifecycle,
      s3: { send },
      bucket: "shutter-media",
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "token",
      edgeBaseUrl: EDGE_BASE,
      edgeAuthToken: EDGE_TOKEN,
      fetch,
    });
    const running = ["one", "two"].map((sourceId) =>
      sourcePurge.purge({ spaceId: "example-public", sourceId, routeClass: "public" }),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(MAX_CONCURRENT_PURGES));

    const queued = sourcePurge.purge({
      spaceId: "example-public",
      sourceId: "three",
      routeClass: "public",
    });
    const outcome = expect(queued).rejects.toThrow("source purge queue wait exceeded");
    await vi.advanceTimersByTimeAsync(PURGE_QUEUE_TIMEOUT_MS);
    await outcome;
    expect(emit).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ event: "control.purge.failed", outcome: "failed" }),
    );

    vi.useRealTimers();
    for (const release of releases) release();
    await expect(Promise.all(running)).resolves.toHaveLength(2);
  });
});
