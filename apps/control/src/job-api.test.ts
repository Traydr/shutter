import { issueSourceCapability } from "@shutter/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobApi } from "./job-api.js";
import type { ControlLogger } from "./logging.js";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import type { PostgresPreviewJobLifecycle } from "./preview-job-lifecycle.js";
import { MemorySpaceRegistry } from "./spaces/memory-registry.js";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const KID = "test-key";
const SPACE_TOKEN = "s".repeat(32);
const VIDEO_TOKEN = "v".repeat(32);
const NOW = new Date("2026-07-11T00:00:00Z");
const NOOP_LOGGER: ControlLogger = { emit() {}, async shutdown() {} };
let spaceRegistry: MemorySpaceRegistry;

async function capability(): Promise<string> {
  const seconds = Math.floor(NOW.getTime() / 1_000);
  return issueSourceCapability(
    {
      space_id: "example-private",
      source_id: "source-1",
      purpose: "preview_job",
      kind: "video",
      locator: "https://sources.example.com/private/originals/source-1.mp4",
      iat: seconds - 60,
      exp: seconds + 3_600,
    },
    { kid: KID, key: KEY },
  );
}

function runtime(
  lifecycle: PostgresPreviewJobLifecycle,
  dispatch = vi.fn(async () => {}),
  sourcePurge?: { purge(source: { spaceId: string; sourceId: string }): Promise<void> },
  logger: ControlLogger = NOOP_LOGGER,
) {
  return {
    logger,
    lifecycle,
    now: () => NOW,
    spaceRegistry,
    executorToken: (kind: "video" | "pdf") => (kind === "video" ? VIDEO_TOKEN : undefined),
    dispatch,
    ...(sourcePurge === undefined ? {} : { sourcePurge }),
  };
}

describe("job API", () => {
  let test: PostgresTestLifecycle;
  let lifecycle: PostgresPreviewJobLifecycle;

  beforeAll(async () => {
    test = await createPostgresTestLifecycle();
    lifecycle = test.lifecycle;
  });

  beforeEach(async () => {
    await test.pool.query("truncate table preview_jobs");
    spaceRegistry = new MemorySpaceRegistry({
      now: () => NOW,
      spaces: [
        {
          id: "example-private",
          routeClass: "private",
          qualities: [75],
          defaultQuality: 75,
          allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/private" }],
          resolvers: [],
        },
        {
          id: "example-public",
          routeClass: "public",
          qualities: [75],
          defaultQuality: 75,
          allowedSourceOrigins: [{ origin: "https://sources.example.com" }],
          resolvers: [],
        },
      ],
    });
    await spaceRegistry.issueApiToken("example-private", "test", SPACE_TOKEN);
    await spaceRegistry.addCapabilityKey("example-private", KID, KEY);
  });

  afterAll(async () => test.close());

  it("submits, polls, claims, and completes one canonical video job", async () => {
    const dispatch = vi.fn(async () => {});
    const app = createJobApi(runtime(lifecycle, dispatch));
    const resource =
      "http://shutter.test/v1/spaces/example-private/sources/source-1/previews/video";
    const submitted = await app.request(resource, {
      method: "PUT",
      headers: { authorization: `Bearer ${SPACE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sourceCapability: await capability() }),
    });
    expect(submitted.status).toBe(202);
    expect(submitted.headers.get("retry-after")).toBe("5");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith("video");

    const claim = await app.request("http://shutter.test/internal/v1/executors/video/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${VIDEO_TOKEN}` },
    });
    expect(claim.status).toBe(200);
    const work = await claim.json<Record<string, unknown>>();
    expect(work).not.toHaveProperty("sourceCapability");
    expect(work.locator).toBe("https://sources.example.com/private/originals/source-1.mp4");
    expect(work.allowedSourceOrigins).toEqual([
      { origin: "https://sources.example.com", pathPrefix: "/private" },
    ]);

    const completed = await app.request(
      "http://shutter.test/internal/v1/executors/video/jobs/example-private/source-1/complete",
      {
        method: "POST",
        headers: { authorization: `Bearer ${VIDEO_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          processingToken: work.processingToken,
          masterKey: work.outputKey,
          width: 1920,
          height: 1080,
          format: "webp",
          objectEtag: "etag-1",
        }),
      },
    );
    expect(completed.status).toBe(204);

    const ready = await app.request(resource, {
      headers: { authorization: `Bearer ${SPACE_TOKEN}` },
    });
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      status: "ready",
      master: {
        sourceId: "source-1",
        kind: "video",
        width: 1920,
        height: 1080,
        format: "webp",
      },
    });
  });

  it("rejects cross-kind executor credentials and malformed submissions", async () => {
    const app = createJobApi(runtime(lifecycle));
    const unauthorized = await app.request("http://shutter.test/internal/v1/executors/pdf/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${VIDEO_TOKEN}` },
    });
    expect(unauthorized.status).toBe(401);

    const malformed = await app.request(
      "http://shutter.test/v1/spaces/example-private/sources/source-1/previews/video",
      {
        method: "PUT",
        headers: { authorization: `Bearer ${SPACE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ sourceCapability: await capability(), extra: true }),
      },
    );
    expect(malformed.status).toBe(400);
  });

  it("lets an accepted job finish after its Space is decommissioned", async () => {
    const app = createJobApi(runtime(lifecycle));
    const resource =
      "http://shutter.test/v1/spaces/example-private/sources/source-1/previews/video";
    const submitted = await app.request(resource, {
      method: "PUT",
      headers: { authorization: `Bearer ${SPACE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sourceCapability: await capability() }),
    });
    expect(submitted.status).toBe(202);
    await spaceRegistry.decommissionSpace("example-private");

    const claim = await app.request("http://shutter.test/internal/v1/executors/video/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${VIDEO_TOKEN}` },
    });
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toMatchObject({
      spaceId: "example-private",
      sourceId: "source-1",
      locator: "https://sources.example.com/private/originals/source-1.mp4",
    });
    expect((await app.request(resource)).status).toBe(404);
  });

  it("keeps a durable submission accepted when its initial dispatch fails", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("executor unavailable");
    });
    const emit = vi.fn<ControlLogger["emit"]>();
    const app = createJobApi(
      runtime(lifecycle, dispatch, undefined, { emit, async shutdown() {} }),
    );
    const response = await app.request(
      "http://shutter.test/v1/spaces/example-private/sources/source-1/previews/video",
      {
        method: "PUT",
        headers: { authorization: `Bearer ${SPACE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ sourceCapability: await capability() }),
      },
    );

    expect(response.status).toBe(202);
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({ event: "control.dispatch.failed" }),
      ),
    );
    expect(
      await lifecycle.read({ spaceId: "example-private", sourceId: "source-1", kind: "video" }),
    ).toMatchObject({ status: "pending" });
  });

  it("authenticates, repeats, and sanitizes Source Purge", async () => {
    const identity = { spaceId: "example-private", sourceId: "source-1", kind: "video" as const };
    await lifecycle.submit(
      {
        ...identity,
        sourceCapability: "opaque",
        capabilityExpiresAt: new Date(NOW.getTime() + 3_600_000),
      },
      NOW,
    );
    const purge = vi.fn(async () => {});
    const app = createJobApi(runtime(lifecycle, undefined, { purge }));
    const url = "http://shutter.test/v1/spaces/example-private/sources/source-1/purge";
    expect((await app.request(url, { method: "POST" })).status).toBe(401);
    expect(
      (
        await app.request("http://shutter.test/v1/spaces/example-public/sources/source-1/purge", {
          method: "POST",
          headers: { authorization: `Bearer ${SPACE_TOKEN}` },
        })
      ).status,
    ).toBe(401);
    for (let count = 0; count < 2; count += 1) {
      const response = await app.request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${SPACE_TOKEN}` },
      });
      expect(response.status).toBe(204);
    }
    expect(purge).toHaveBeenCalledTimes(2);

    const failing = createJobApi(
      runtime(lifecycle, undefined, {
        purge: async () => Promise.reject(new Error("secret detail")),
      }),
    );
    const failed = await failing.request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${SPACE_TOKEN}` },
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: { code: "service_unavailable" } });
  });

  it("distinguishes a missing active Space from registry unavailability", async () => {
    const app = createJobApi(runtime(lifecycle));
    const missing = await app.request(
      "http://shutter.test/v1/spaces/unknown/sources/source-1/previews/video",
      { headers: { authorization: `Bearer ${SPACE_TOKEN}` } },
    );
    expect(missing.status).toBe(404);

    const unavailable = vi
      .spyOn(spaceRegistry, "getActiveSpacePolicy")
      .mockRejectedValue(new Error("database unavailable"));
    const failed = await app.request(
      "http://shutter.test/v1/spaces/example-private/sources/source-1/previews/video",
      { headers: { authorization: `Bearer ${SPACE_TOKEN}` } },
    );
    expect(failed.status).toBe(503);
    unavailable.mockRestore();
  });
});
