import { type DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { buildSourceCacheTag } from "@shutter/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import type { PostgresRenditionJobLifecycle } from "./rendition-job-lifecycle.js";
import { createSourcePurge } from "./source-purge.js";

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
  it("deletes every paginated prefix before purging the hashed cache tag", async () => {
    const identity = { spaceId: "pane-view", sourceId: "source/one", kind: "video" as const };
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
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      events.push("tag");
      expect(JSON.parse(String(init?.body))).toEqual({
        tags: [await buildSourceCacheTag("pane-view", "source/one")],
      });
      return Response.json({ success: true });
    });
    const sourcePurge = createSourcePurge({
      lifecycle,
      s3: { send } as unknown as S3Client,
      bucket: "shutter-renditions",
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "token",
      fetch,
    });

    await sourcePurge.purge({ spaceId: "pane-view", sourceId: "source/one" });
    expect(await lifecycle.read(identity)).toBeUndefined();
    expect(events.at(-1)).toBe("tag");
    expect(events.filter((event) => event === "delete")).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/zones/zone-id/purge_cache",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("stops before cache-tag purge when object deletion partially fails", async () => {
    const send = vi.fn(async (command: ListObjectsV2Command | DeleteObjectsCommand) =>
      command instanceof ListObjectsV2Command
        ? { Contents: [{ Key: "object" }], IsTruncated: false }
        : { Errors: [{ Key: "object", Code: "InternalError" }] },
    );
    const fetch = vi.fn();
    const sourcePurge = createSourcePurge({
      lifecycle,
      s3: { send } as unknown as S3Client,
      bucket: "shutter-renditions",
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "token",
      fetch,
    });
    await expect(sourcePurge.purge({ spaceId: "pane-view", sourceId: "source" })).rejects.toThrow(
      "rendition deletion failed",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries safely after a Cloudflare failure", async () => {
    const identity = { spaceId: "pane-view", sourceId: "source", kind: "pdf" as const };
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
      .mockResolvedValueOnce(Response.json({ success: false }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    const sourcePurge = createSourcePurge({
      lifecycle,
      s3: { send } as unknown as S3Client,
      bucket: "shutter-renditions",
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "token",
      fetch,
    });
    await expect(sourcePurge.purge({ spaceId: "pane-view", sourceId: "source" })).rejects.toThrow(
      "cache tag purge failed",
    );
    expect(await lifecycle.read(identity)).toBeUndefined();
    await expect(
      sourcePurge.purge({ spaceId: "pane-view", sourceId: "source" }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
