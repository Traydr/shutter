import { type DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { buildSourceCacheTag } from "@shutter/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlLogger } from "./logging.js";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import type { PostgresRenditionJobLifecycle } from "./rendition-job-lifecycle.js";
import { createSourcePurge } from "./source-purge.js";

const EDGE_BASE = "https://edge.shutter.test";
const EDGE_TOKEN = "o".repeat(32);
const NOOP_LOGGER: ControlLogger = { emit() {}, async shutdown() {} };

describe("Source Purge", () => {
  let test: PostgresTestLifecycle;
  let lifecycle: PostgresRenditionJobLifecycle;

  beforeAll(async () => {
    test = await createPostgresTestLifecycle();
    lifecycle = test.lifecycle;
  });

  afterAll(async () => test.close());

  beforeEach(async () => {
    await test.pool.query("truncate table rendition_jobs");
  });

  function createPurge(fetch: typeof globalThis.fetch, send: S3Client["send"]) {
    return createSourcePurge({
      logger: NOOP_LOGGER,
      lifecycle,
      s3: { send } as unknown as S3Client,
      bucket: "shutter-renditions",
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "token",
      edgeBaseUrl: EDGE_BASE,
      edgeAuthToken: EDGE_TOKEN,
      fetch,
    });
  }

  it("deletes every paginated prefix before purging Worker and zone cache tags", async () => {
    const identity = { spaceId: "example-private", sourceId: "source/one", kind: "video" as const };
    await lifecycle.submit(
      {
        ...identity,
        sourceCapability: "opaque",
        capabilityExpiresAt: new Date("2026-07-14T00:00:00Z"),
      },
      new Date("2026-07-13T00:00:00Z"),
    );
    const events: string[] = [];
    let publicPages = 0;
    const tag = await buildSourceCacheTag("example-private", "source/one");
    const send = vi.fn(async (command: ListObjectsV2Command | DeleteObjectsCommand) => {
      if (command instanceof ListObjectsV2Command) {
        events.push(`list:${command.input.Prefix}`);
        if (command.input.Prefix?.includes("/public/")) {
          publicPages += 1;
          return publicPages === 1
            ? {
                Contents: [{ Key: `${command.input.Prefix}one.webp` }],
                IsTruncated: true,
                NextContinuationToken: "next",
              }
            : { Contents: [{ Key: `${command.input.Prefix}two.webp` }], IsTruncated: false };
        }
        return { Contents: [], IsTruncated: false };
      }
      events.push("delete");
      return { Errors: [] };
    });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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

    await sourcePurge.purge({ spaceId: "example-private", sourceId: "source/one" });
    expect(await lifecycle.read(identity)).toBeUndefined();
    expect(events.filter((event) => event === "worker" || event === "tag")).toEqual([
      "worker",
      "tag",
    ]);
    expect(events.filter((event) => event === "delete")).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/zones/zone-id/purge_cache",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("stops before later purge stages when an earlier stage fails", async () => {
    const deleteFails = createPurge(
      vi.fn(),
      vi.fn(async (command: ListObjectsV2Command | DeleteObjectsCommand) =>
        command instanceof ListObjectsV2Command
          ? { Contents: [{ Key: "object" }], IsTruncated: false }
          : { Errors: [{ Key: "object", Code: "InternalError" }] },
      ),
    );
    await expect(
      deleteFails.purge({ spaceId: "example-private", sourceId: "source" }),
    ).rejects.toThrow("rendition deletion failed");

    const workerFetch = vi.fn(async () => new Response(null, { status: 503 }));
    const workerFails = createPurge(
      workerFetch,
      vi.fn(async (command: ListObjectsV2Command | DeleteObjectsCommand) =>
        command instanceof ListObjectsV2Command
          ? { Contents: [], IsTruncated: false }
          : { Errors: [] },
      ),
    );
    await expect(
      workerFails.purge({ spaceId: "example-private", sourceId: "source" }),
    ).rejects.toThrow("worker cache purge failed");
    expect(workerFetch).toHaveBeenCalledTimes(1);
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
    const send = vi.fn(async (command: ListObjectsV2Command | DeleteObjectsCommand) =>
      command instanceof ListObjectsV2Command
        ? { Contents: [], IsTruncated: false }
        : { Errors: [] },
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ success: false }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    const sourcePurge = createPurge(fetch, send);
    await expect(
      sourcePurge.purge({ spaceId: "example-private", sourceId: "source" }),
    ).rejects.toThrow("cache tag purge failed");
    expect(await lifecycle.read(identity)).toBeUndefined();
    await expect(
      sourcePurge.purge({ spaceId: "example-private", sourceId: "source" }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
