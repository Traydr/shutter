import { env, reset, SELF } from "cloudflare:test";
import { buildR2CacheKey, buildSourceCacheTag, verifySourceCapability } from "@shutter/protocol";
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
        allowedSourceOrigins: [{ origin: "https://example-project.ufs.sh", pathPrefix: "/f" }],
        resolvers: [
          {
            id: "uploadthing",
            type: "uploadthing",
            allowedProjectIds: ["example-project"],
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
      "https://origin.shutter.test/internal/v1/optimize-master",
    );
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
      SELF.fetch(
        "https://edge.shutter.test/v1/public/example-public/resolver/uploadthing/example-project%2Fresolver-miss?w=640&q=75",
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses.map((response) => response.headers.get("x-shutter-cache"))).toEqual([
      "origin",
      "origin",
      "origin",
    ]);
    expect(origin).toHaveBeenCalledTimes(3);
  });

  it("serves an allowlisted UploadThing resolver reference from canonical public cache identity", async () => {
    const sourceId = "example-project/file_key-1";
    const identity = {
      routeClass: "public" as const,
      spaceId: "example-public",
      sourceId,
      input: { type: "source" as const },
      width: 640,
      quality: 75,
    };
    await env.MEDIA_STORE.put(await buildR2CacheKey(identity), "example-public-image", {
      httpMetadata: { contentType: "image/webp" },
    });

    const response = await SELF.fetch(
      "https://edge.shutter.test/v1/public/example-public/resolver/uploadthing/example-project%2Ffile_key-1?w=640&q=75",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-shutter-cache")).toBe("r2-hit");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("example-public-image");
  });

  it("normalizes public resolver parameters and rejects unallowlisted projects", async () => {
    const normalized = await SELF.fetch(
      "https://edge.shutter.test/v1/public/example-public/resolver/uploadthing/example-project%2Ffile_key-1?w=639",
      { redirect: "manual" },
    );
    expect(normalized.status).toBe(308);
    expect(normalized.headers.get("location")).toBe(
      "https://edge.shutter.test/v1/public/example-public/resolver/uploadthing/example-project%2Ffile_key-1?w=640&q=75",
    );

    const rejected = await SELF.fetch(
      "https://edge.shutter.test/v1/public/example-public/resolver/uploadthing/notallowed%2Ffile_key-1?w=640&q=75",
    );
    expect(rejected.status).toBe(404);
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
