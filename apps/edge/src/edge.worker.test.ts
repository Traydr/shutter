import { env, reset, SELF } from "cloudflare:test";
import {
  buildMasterPreviewKey,
  buildR2CacheKey,
  buildSourceCacheTag,
  verifySourceCapability,
} from "@shutter/protocol";
import { issueSourceCapabilityWithIv } from "@shutter/protocol/testing";
import {
  runCapabilityConformance,
  TEST_CAPABILITY_KEY,
  TEST_CAPABILITY_KID,
} from "@shutter/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEdgeConfigForTest } from "./config-snapshot.js";

function snapshotResponse(): Response {
  return Response.json({
    schemaVersion: "v1",
    generation: 1,
    generatedAt: new Date().toISOString(),
    spaces: [
      {
        id: "example-public",
        routeClass: "public",
        qualities: [30, 50, 75],
        defaultQuality: 75,
        allowedSourceOrigins: [
          { origin: "https://example-project.ufs.sh", pathPrefix: "/f" },
          { origin: "https://latch.example", pathPrefix: "/cdn/v1" },
          { origin: "https://objects.example.test", pathPrefix: "/example-bucket" },
        ],
        resolvers: [
          // The retired kind stays parseable until migration 0003 rewrites it.
          { id: "uploadthing", type: "uploadthing", allowedProjectIds: ["example-project"] },
          {
            id: "ut",
            type: "template",
            url: "https://{project}.ufs.sh/f/{file}",
            placeholders: { project: { allowed: ["example-project"] }, file: {} },
          },
          {
            id: "lw",
            type: "template",
            url: "https://latch.example/cdn/v1/{token}",
            placeholders: { token: {} },
          },
          {
            id: "media",
            type: "s3",
            endpoint: "https://objects.example.test",
            region: "auto",
            bucket: "example-bucket",
            pathStyle: true,
            keyTemplate: "originals/{key}",
          },
        ],
      },
      {
        id: "example-private",
        routeClass: "private",
        qualities: [30, 75, 80],
        defaultQuality: 75,
        allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/private" }],
        resolvers: [],
      },
    ],
    capabilityKeys: {
      "example-public": {
        [TEST_CAPABILITY_KID]: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      },
      "example-private": {
        [TEST_CAPABILITY_KID]: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      },
    },
  });
}

function configFetch(
  origin?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const pathname = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (pathname === "/internal/v1/edge/config") {
      return snapshotResponse();
    }
    if (pathname === "/internal/v1/edge/config/refresh") {
      return new Response(null, { status: 204 });
    }
    if (origin !== undefined) return origin(input, init);
    throw new Error("unexpected origin request");
  };
}

beforeEach(() => {
  resetEdgeConfigForTest();
  vi.stubGlobal("fetch", configFetch());
});

afterEach(async () => {
  resetEdgeConfigForTest();
  vi.unstubAllGlobals();
  await reset();
});

function tamper(value: string): string {
  const index = Math.floor(value.length / 2);
  const replacement = value[index] === "A" ? "B" : "A";
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

describe("edge app", () => {
  it("fails a malformed private source capability closed", async () => {
    const response = await SELF.fetch(
      "https://edge.shutter.test/v1/private/example-private/source/not-a-capability?w=640&q=75",
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("verifies a private capability before redirecting a non-canonical URL", async () => {
    // The private gate is `before`: a bad capability answers 403 even when the
    // query would otherwise redirect, so the check cannot drift behind the 308.
    const source = await SELF.fetch(
      "https://edge.shutter.test/v1/private/example-private/source/not-a-capability?w=639",
      { redirect: "manual" },
    );
    expect(source.status).toBe(403);
    expect(source.headers.get("cache-control")).toBe("private, no-store");
    const master = await SELF.fetch(
      "https://edge.shutter.test/v1/private/example-private/master/not-a-capability?w=639",
      { redirect: "manual" },
    );
    expect(master.status).toBe(403);
    expect(master.headers.get("cache-control")).toBe("private, no-store");
  });

  it("validates a private source capability before returning cached bytes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sourceId = "private-source";
    const token = await issueSourceCapabilityWithIv(
      {
        space_id: "example-private",
        source_id: sourceId,
        purpose: "image_source",
        locator: "https://sources.example.com/private/originals/private-source.webp",
        iat: now - 60,
        exp: now + 3_600,
      },
      { kid: TEST_CAPABILITY_KID, key: TEST_CAPABILITY_KEY },
      Uint8Array.from([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]),
    );
    const identity = {
      routeClass: "private" as const,
      spaceId: "example-private",
      sourceId,
      input: { type: "source" as const },
      width: 640,
      quality: 75,
    };
    await env.MEDIA_STORE.put(await buildR2CacheKey(identity), "private-source-image", {
      httpMetadata: { contentType: "image/webp" },
    });

    const tampered = await SELF.fetch(
      `https://edge.shutter.test/v1/private/example-private/source/${tamper(token)}?w=640&q=75`,
    );
    expect(tampered.status).toBe(403);
    expect(await tampered.text()).not.toContain("private-source-image");

    const first = await SELF.fetch(
      `https://edge.shutter.test/v1/private/example-private/source/${token}?w=640&q=75`,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("x-shutter-cache")).toBe("r2-hit");
    expect(new TextDecoder().decode(await first.arrayBuffer())).toBe("private-source-image");

    const second = await SELF.fetch(
      `https://edge.shutter.test/v1/private/example-private/source/${token}?w=640&q=75`,
    );
    expect(second.headers.get("x-shutter-cache")).toBe("edge-hit");
  });

  it("validates a private capability before returning R2 or edge-cache bytes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sourceId = "private-master-source";
    const token = await issueSourceCapabilityWithIv(
      {
        space_id: "example-private",
        source_id: sourceId,
        purpose: "master_preview",
        kind: "video",
        iat: now - 60,
        exp: now + 3_600,
      },
      { kid: TEST_CAPABILITY_KID, key: TEST_CAPABILITY_KEY },
      Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    );
    const identity = {
      routeClass: "private" as const,
      spaceId: "example-private",
      sourceId,
      input: { type: "master" as const, kind: "video" as const },
      width: 640,
      quality: 75,
    };
    await env.MEDIA_STORE.put(await buildR2CacheKey(identity), "private-image", {
      httpMetadata: { contentType: "image/webp" },
    });

    const tampered = await SELF.fetch(
      `https://edge.shutter.test/v1/private/example-private/master/${tamper(token)}?w=640&q=75`,
    );
    expect(tampered.status).toBe(403);
    expect(await tampered.text()).not.toContain("private-image");

    const first = await SELF.fetch(
      `https://edge.shutter.test/v1/private/example-private/master/${token}?w=640&q=75`,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("x-shutter-cache")).toBe("r2-hit");
    expect(new TextDecoder().decode(await first.arrayBuffer())).toBe("private-image");

    const second = await SELF.fetch(
      `https://edge.shutter.test/v1/private/example-private/master/${token}?w=640&q=75`,
    );
    expect(second.headers.get("x-shutter-cache")).toBe("edge-hit");
    expect(new TextDecoder().decode(await second.arrayBuffer())).toBe("private-image");
  });

  it("renders a private master miss through the authenticated master bridge", async () => {
    const origin = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("rendered-private-master", {
          headers: { "content-type": "image/webp" },
        }),
    );
    vi.stubGlobal("fetch", configFetch(origin));
    const now = Math.floor(Date.now() / 1000);
    const token = await issueSourceCapabilityWithIv(
      {
        space_id: "example-private",
        source_id: "private-master-miss",
        purpose: "master_preview",
        kind: "pdf",
        iat: now - 60,
        exp: now + 3_600,
      },
      { kid: TEST_CAPABILITY_KID, key: TEST_CAPABILITY_KEY },
      Uint8Array.from([1, 3, 5, 7, 9, 11, 2, 4, 6, 8, 10, 12]),
    );
    const response = await SELF.fetch(
      `https://edge.shutter.test/v1/private/example-private/master/${token}?w=640&q=75`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-shutter-cache")).toBe("origin");
    expect(await response.text()).toBe("rendered-private-master");
    expect(origin).toHaveBeenCalledOnce();
    expect(origin.mock.calls[0]?.[0].toString()).toBe(
      "https://origin.shutter.test/internal/v2/optimize",
    );
    expect(JSON.parse(String(origin.mock.calls[0]?.[1]?.body))).toEqual({
      spaceId: "example-private",
      input: { type: "master", sourceId: "private-master-miss", kind: "pdf" },
      width: 640,
      quality: 75,
    });
  });

  it("serves public video and PDF masters with canonical public cache identities", async () => {
    for (const kind of ["video", "pdf"] as const) {
      const identity = {
        routeClass: "public" as const,
        spaceId: "example-public",
        sourceId: `public/${kind}`,
        input: { type: "master" as const, kind },
        width: 640,
        quality: 75,
      };
      await env.MEDIA_STORE.put(await buildR2CacheKey(identity), `${kind}-master`, {
        httpMetadata: { contentType: "image/webp" },
      });
      const first = await SELF.fetch(
        `https://edge.shutter.test/v1/public/example-public/master/${kind}/public%2F${kind}?w=640&q=75`,
      );
      expect(first.status).toBe(200);
      expect(first.headers.get("x-shutter-cache")).toBe("r2-hit");
      expect(await first.text()).toBe(`${kind}-master`);
      const second = await SELF.fetch(
        `https://edge.shutter.test/v1/public/example-public/master/${kind}/public%2F${kind}?w=640&q=75`,
      );
      expect(second.headers.get("x-shutter-cache")).toBe("edge-hit");
    }
  });

  it("normalizes public master requests and rejects route and kind confusion", async () => {
    const normalized = await SELF.fetch(
      "https://edge.shutter.test/v1/public/example-public/master/video/source?w=639",
      { redirect: "manual" },
    );
    expect(normalized.status).toBe(308);
    expect(normalized.headers.get("location")).toBe(
      "https://edge.shutter.test/v1/public/example-public/master/video/source?w=640&q=75",
    );
    expect(
      (
        await SELF.fetch(
          "https://edge.shutter.test/v1/public/example-public/master/image/source?w=640&q=75",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await SELF.fetch(
          "https://edge.shutter.test/v1/public/example-private/master/video/source?w=640&q=75",
        )
      ).status,
    ).toBe(404);
  });

  it("renders a public master miss through Control and stores it in R2", async () => {
    const origin = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("rendered-public-master", {
          headers: { "content-type": "image/webp" },
        }),
    );
    vi.stubGlobal("fetch", configFetch(origin));
    const response = await SELF.fetch(
      "https://edge.shutter.test/v1/public/example-public/master/video/public-miss?w=640&q=75",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-shutter-cache")).toBe("origin");
    expect(await response.text()).toBe("rendered-public-master");
    expect(origin).toHaveBeenCalledOnce();
  });

  it("excludes a public located-source capability from canonical cached identity", async () => {
    const sourceId = "public-located-source";
    const identity = {
      routeClass: "public" as const,
      spaceId: "example-public",
      sourceId,
      input: { type: "source" as const },
      width: 640,
      quality: 75,
    };
    await env.MEDIA_STORE.put(await buildR2CacheKey(identity), "public-image", {
      httpMetadata: { contentType: "image/webp" },
    });

    const response = await SELF.fetch(
      `https://edge.shutter.test/v1/public/example-public/located/${sourceId}/not-a-capability?w=640&q=75`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-shutter-cache")).toBe("r2-hit");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400, s-maxage=2592000");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("public-image");
  });

  it("fails a public located-source miss closed before contacting the origin", async () => {
    const response = await SELF.fetch(
      "https://edge.shutter.test/v1/public/example-public/located/missing/not-a-capability?w=640&q=75",
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("renders source-route misses through the authenticated origin", async () => {
    const origin = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response("rendered-source", { headers: { "content-type": "image/webp" } });
    });
    vi.stubGlobal("fetch", configFetch(origin));
    const now = Math.floor(Date.now() / 1000);
    const privateToken = await issueSourceCapabilityWithIv(
      {
        space_id: "example-private",
        source_id: "private-source-miss",
        purpose: "image_source",
        locator: "https://sources.example.com/private/originals/private-source-miss.webp",
        iat: now - 60,
        exp: now + 3_600,
      },
      { kid: TEST_CAPABILITY_KID, key: TEST_CAPABILITY_KEY },
      Uint8Array.from([2, 4, 6, 8, 10, 12, 1, 3, 5, 7, 9, 11]),
    );
    const locatedToken = await issueSourceCapabilityWithIv(
      {
        space_id: "example-public",
        source_id: "public-located-miss",
        purpose: "image_source",
        locator: "https://example-project.ufs.sh/f/public-located-miss",
        iat: now - 60,
        exp: now + 3_600,
      },
      { kid: TEST_CAPABILITY_KID, key: TEST_CAPABILITY_KEY },
      Uint8Array.from([3, 6, 9, 12, 2, 5, 8, 11, 1, 4, 7, 10]),
    );

    const responses = await Promise.all([
      SELF.fetch(
        `https://edge.shutter.test/v1/private/example-private/source/${privateToken}?w=640&q=75`,
      ),
      SELF.fetch(
        `https://edge.shutter.test/v1/public/example-public/located/public-located-miss/${locatedToken}?w=640&q=75`,
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.headers.get("x-shutter-cache"))).toEqual([
      "origin",
      "origin",
    ]);
    expect(origin).toHaveBeenCalledTimes(2);
    const originCalls = origin.mock.calls.map(([input, init]) => ({
      url: new URL(input.toString()),
      body: JSON.parse(String(init?.body)),
    }));
    for (const call of originCalls) {
      expect(call.url.pathname).toBe("/internal/v2/optimize");
      expect(call.url.search).toBe("");
    }
    expect(originCalls.map((call) => call.body)).toEqual([
      {
        spaceId: "example-private",
        input: {
          type: "located",
          sourceUrl: "https://sources.example.com/private/originals/private-source-miss.webp",
        },
        width: 640,
        quality: 75,
      },
      {
        spaceId: "example-public",
        input: {
          type: "located",
          sourceUrl: "https://example-project.ufs.sh/f/public-located-miss",
        },
        width: 640,
        quality: 75,
      },
    ]);
  });

  it("serves a v2 template reference from canonical public cache identity and refuses HEAD on it", async () => {
    const identity = {
      routeClass: "public" as const,
      spaceId: "example-public",
      sourceId: "ut/example-project/file_key-1",
      input: { type: "source" as const },
      width: 640,
      quality: 75,
    };
    await env.MEDIA_STORE.put(await buildR2CacheKey(identity), "example-public-image", {
      httpMetadata: { contentType: "image/webp" },
    });
    const url =
      "https://edge.shutter.test/v2/example-public/ut/example-project/file_key-1?w=640&q=75";

    const response = await SELF.fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-shutter-cache")).toBe("r2-hit");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400, s-maxage=2592000");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("example-public-image");

    const head = await SELF.fetch(url, { method: "HEAD" });
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");
  });

  it("normalizes v2 parameters and fails every resolution miss closed", async () => {
    const base = "https://edge.shutter.test/v2/example-public/ut/example-project/file_key-1";
    const normalized = await SELF.fetch(`${base}?w=639`, { redirect: "manual" });
    expect(normalized.status).toBe(308);
    expect(normalized.headers.get("location")).toBe(`${base}?w=640&q=75`);
    const preview = await SELF.fetch(`${base}?w=639&preview=video`, { redirect: "manual" });
    expect(preview.status).toBe(308);
    expect(preview.headers.get("location")).toBe(`${base}?preview=video&w=640&q=75`);

    for (const search of ["?q=75", "?preview=pdf", "?w=640&token=x", "?w=640&format=avif"]) {
      const rejected = await SELF.fetch(`${base}${search}`);
      expect(rejected.status, search).toBe(400);
      expect(rejected.headers.get("cache-control")).toBe("private, no-store");
    }
    for (const path of [
      "/v2/example-public/ut/notallowed/file_key-1",
      "/v2/example-public/ut/example-project",
      "/v2/example-public/ut/example-project/a/b",
      "/v2/example-public/ut/example-project/..",
      "/v2/example-public/ut/example-project/%2e%2e",
      "/v2/example-public/ut/example-project/bad%2",
      "/v2/example-public/nope/file_key-1",
      "/v2/example-private/media/file_key-1",
      "/v2/missing/media/file_key-1",
    ]) {
      const missing = await SELF.fetch(`https://edge.shutter.test${path}?w=640&q=75`);
      expect(missing.status, path).toBe(404);
    }
    const posted = await SELF.fetch(`${base}?w=640&q=75`, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
    const postedDelivery = await SELF.fetch(base, { method: "POST" });
    expect(postedDelivery.status).toBe(405);
    expect(postedDelivery.headers.get("allow")).toBe("GET, HEAD");
  });

  it("optimizes v2 misses through the v2 optimize wire with a resolved input", async () => {
    const bodies: string[] = [];
    const origin = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      bodies.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
      return new Response("rendered-v2", { headers: { "content-type": "image/webp" } });
    });
    vi.stubGlobal("fetch", configFetch(origin));

    const template = await SELF.fetch(
      "https://edge.shutter.test/v2/example-public/ut/example-project/miss-1?w=640&q=75",
    );
    expect(template.status).toBe(200);
    expect(template.headers.get("x-shutter-cache")).toBe("origin");
    expect(await template.text()).toBe("rendered-v2");
    const s3 = await SELF.fetch(
      "https://edge.shutter.test/v2/example-public/media/miss-2?w=640&q=75",
    );
    expect(s3.status).toBe(200);
    const missingMaster = await SELF.fetch(
      "https://edge.shutter.test/v2/example-public/media/clip.mp4?preview=video&w=640&q=75",
    );
    expect(missingMaster.status).toBe(404);
    expect(missingMaster.headers.get("cache-control")).toBe("private, no-store");
    await env.MEDIA_STORE.put(
      await buildMasterPreviewKey("example-public", "media/clip.mp4", "video"),
      "master-bytes",
      { httpMetadata: { contentType: "image/webp" } },
    );
    const master = await SELF.fetch(
      "https://edge.shutter.test/v2/example-public/media/clip.mp4?preview=video&w=640&q=75",
    );
    expect(master.status).toBe(200);

    expect(bodies).toEqual([
      `POST /internal/v2/optimize ${JSON.stringify({
        spaceId: "example-public",
        input: { type: "resolved", resolverId: "ut", reference: ["example-project", "miss-1"] },
        width: 640,
        quality: 75,
      })}`,
      `POST /internal/v2/optimize ${JSON.stringify({
        spaceId: "example-public",
        input: { type: "resolved", resolverId: "media", reference: ["miss-2"] },
        width: 640,
        quality: 75,
      })}`,
      `POST /internal/v2/optimize ${JSON.stringify({
        spaceId: "example-public",
        input: { type: "master", sourceId: "media/clip.mp4", kind: "video" },
        width: 640,
        quality: 75,
      })}`,
    ]);
    const stored = (await env.MEDIA_STORE.list()).objects.map((object) => object.key);
    expect(stored).toContain(
      await buildR2CacheKey({
        routeClass: "public",
        spaceId: "example-public",
        sourceId: "media/clip.mp4",
        input: { type: "master", kind: "video" },
        width: 640,
        quality: 75,
      }),
    );
  });

  it("delivers an S3 reference by asking Control for a presigned locator", async () => {
    const calls: string[] = [];
    const locator = "https://objects.example.test/example-bucket/originals/clip.mp4?sig=1";
    const origin = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(`${request.method} ${request.url}`);
      if (new URL(request.url).pathname === "/internal/v2/resolve") {
        expect(request.headers.get("authorization")).toBe(`Bearer ${env.ORIGIN_AUTH_TOKEN}`);
        expect(await request.json()).toEqual({
          spaceId: "example-public",
          resolverId: "media",
          reference: ["clip.mp4"],
        });
        return Response.json({ locator, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      return new Response("video-bytes", {
        headers: { "content-type": "video/mp4", "content-length": "11" },
      });
    });
    vi.stubGlobal("fetch", configFetch(origin));

    const url = "https://edge.shutter.test/v2/example-public/media/clip.mp4";
    const first = await SELF.fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-shutter-cache")).toBe("origin");
    expect(first.headers.get("cache-tag")).toBe(
      await buildSourceCacheTag("example-public", "media/clip.mp4"),
    );
    expect(await first.text()).toBe("video-bytes");
    expect(calls).toEqual([
      "POST https://origin.shutter.test/internal/v2/resolve",
      `GET ${locator}`,
    ]);

    const second = await SELF.fetch(url);
    expect(second.headers.get("x-shutter-cache")).toBe("edge-hit");
    expect(calls).toHaveLength(2);
  });

  it("answers a cold HEAD from a GET of the presigned locator", async () => {
    const locator = "https://objects.example.test/example-bucket/originals/doc.pdf?sig=1";
    const methods: string[] = [];
    const origin = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/internal/v2/resolve") {
        return Response.json({ locator, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      methods.push(request.method);
      return new Response("pdf-bytes", {
        headers: { "content-type": "application/pdf", "content-length": "9" },
      });
    });
    vi.stubGlobal("fetch", configFetch(origin));

    const head = await SELF.fetch("https://edge.shutter.test/v2/example-public/media/doc.pdf", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("9");
    expect(await head.text()).toBe("");
    expect(methods).toEqual(["GET"]);
  });

  it("refuses a presigned locator outside the allowed origins", async () => {
    const origin = vi.fn(async () =>
      Response.json({
        locator: "https://elsewhere.example/example-bucket/originals/x?sig=1",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    );
    vi.stubGlobal("fetch", configFetch(origin));
    const response = await SELF.fetch("https://edge.shutter.test/v2/example-public/media/x");
    expect(response.status).toBe(403);
    expect(origin).toHaveBeenCalledOnce();
  });

  it("keeps two resolvers with the same reference apart", async () => {
    for (const resolverId of ["lw", "media"]) {
      await env.MEDIA_STORE.put(
        await buildR2CacheKey({
          routeClass: "public",
          spaceId: "example-public",
          sourceId: `${resolverId}/same`,
          input: { type: "source" },
          width: 640,
          quality: 75,
        }),
        `${resolverId}-bytes`,
        { httpMetadata: { contentType: "image/webp" } },
      );
    }
    for (const resolverId of ["lw", "media"]) {
      const response = await SELF.fetch(
        `https://edge.shutter.test/v2/example-public/${resolverId}/same?w=640&q=75`,
      );
      expect(await response.text()).toBe(`${resolverId}-bytes`);
    }
  });
});

describe("workerd protocol conformance", () => {
  it("matches the shared AES-GCM fixtures", async () => {
    await runCapabilityConformance({
      issueWithIv: issueSourceCapabilityWithIv,
      verify: verifySourceCapability,
    });
  });

  it("rejects unauthenticated Worker cache purge", async () => {
    const response = await SELF.fetch("https://edge.shutter.test/internal/v1/cache/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: ["shutter-v1-tag"] }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects invalid Worker cache purge bodies", async () => {
    const response = await SELF.fetch("https://edge.shutter.test/internal/v1/cache/purge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ORIGIN_AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tags: [] }),
    });
    expect(response.status).toBe(400);
  });

  it("purges Worker Cache API tags when authorized", async () => {
    const tag = await buildSourceCacheTag("example-private", "private-source");
    const response = await SELF.fetch("https://edge.shutter.test/internal/v1/cache/purge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ORIGIN_AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tags: [tag] }),
    });
    expect([204, 503]).toContain(response.status);
    if (response.status === 204) expect(await response.text()).toBe("");
  });
});
