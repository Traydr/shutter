import { env, reset, SELF } from "cloudflare:test";
import { buildSourceCacheTag } from "@shutter/protocol";
import { issueSourceCapabilityWithIv } from "@shutter/protocol/testing";
import { TEST_CAPABILITY_KEY, TEST_CAPABILITY_KID } from "@shutter/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEdgeConfigForTest } from "./config-snapshot.js";

const PUBLIC_RESOLVER_URL =
  "https://edge.shutter.test/v1/public/example-public/delivery/resolver/uploadthing/example-project%2Fsource-01";

function snapshotResponse(): Response {
  return Response.json({
    schemaVersion: "v1",
    generation: 1,
    generatedAt: new Date().toISOString(),
    spaces: [
      {
        id: "example-public",
        routeClass: "public",
        qualities: [75],
        defaultQuality: 75,
        allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/public" }],
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
        qualities: [75],
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

function withOrigin(origin: (request: Request) => Promise<Response>): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/internal/v1/edge/config") return snapshotResponse();
    if (pathname === "/internal/v1/edge/config/refresh") {
      return new Response(null, { status: 204 });
    }
    return origin(request);
  };
}

function sourceResponse(
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-length": String(new TextEncoder().encode(body).byteLength),
      "content-type": contentType,
      ...headers,
    },
  });
}

async function deliveryToken(
  routeClass: "public" | "private",
  sourceId: string,
  locator: string,
  ivOffset = 0,
  purpose: "source_delivery" | "image_source" = "source_delivery",
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return issueSourceCapabilityWithIv(
    {
      space_id: `example-${routeClass}`,
      source_id: sourceId,
      purpose,
      locator,
      iat: now - 60,
      exp: now + 3_600,
    },
    { kid: TEST_CAPABILITY_KID, key: TEST_CAPABILITY_KEY },
    Uint8Array.from({ length: 12 }, (_, index) => index + ivOffset),
  );
}

function tamper(value: string): string {
  const index = Math.floor(value.length / 2);
  return `${value.slice(0, index)}${value[index] === "A" ? "B" : "A"}${value.slice(index + 1)}`;
}

beforeEach(() => {
  resetEdgeConfigForTest();
});

afterEach(async () => {
  resetEdgeConfigForTest();
  vi.unstubAllGlobals();
  await reset();
});

describe("Source Delivery", () => {
  it("delivers and caches a small public image, including HEAD", async () => {
    const origin = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://example-project.ufs.sh/f/source-01");
      expect(request.headers.get("accept-encoding")).toBe("identity");
      return sourceResponse("small-image", "image/jpeg", {
        "accept-ranges": "bytes",
        etag: '"image-v1"',
        "last-modified": "Wed, 01 Jul 2026 12:00:00 GMT",
        "set-cookie": "secret=not-forwarded",
        "x-origin-secret": "not-forwarded",
      });
    });
    vi.stubGlobal("fetch", withOrigin(origin));

    const first = await SELF.fetch(PUBLIC_RESOLVER_URL);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("small-image");
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect(first.headers.get("content-disposition")).toBe("inline");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("x-shutter-cache")).toBe("origin");
    expect(first.headers.get("cache-tag")).toBe(
      await buildSourceCacheTag("example-public", "example-project/source-01"),
    );
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(first.headers.get("x-origin-secret")).toBeNull();

    const head = await SELF.fetch(PUBLIC_RESOLVER_URL, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe("11");
    expect(head.headers.get("x-shutter-cache")).toBe("edge-hit");
    expect(origin).toHaveBeenCalledOnce();
    expect((await env.MEDIA_STORE.list()).objects).toHaveLength(0);
  });

  it("serves warm video ranges from one complete cache entry", async () => {
    const video = "0123456789abcdefghij";
    const origin = vi.fn(async () =>
      sourceResponse(video, "video/mp4", {
        "accept-ranges": "bytes",
        etag: '"video-v1"',
        "last-modified": "Wed, 01 Jul 2026 12:00:00 GMT",
      }),
    );
    vi.stubGlobal("fetch", withOrigin(origin));
    expect((await SELF.fetch(PUBLIC_RESOLVER_URL)).status).toBe(200);

    const range = await SELF.fetch(PUBLIC_RESOLVER_URL, {
      headers: { range: "bytes=5-9" },
    });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("56789");
    expect(range.headers.get("content-range")).toBe("bytes 5-9/20");
    expect(range.headers.get("accept-ranges")).toBe("bytes");
    expect(range.headers.get("etag")).toBe('"video-v1"');
    expect(range.headers.get("x-shutter-cache")).toBe("edge-hit");
    expect(origin).toHaveBeenCalledOnce();
  });

  it("streams a cold range from the origin, then warms one complete entry for seeks", async () => {
    const video = "0123456789abcdefghij";
    const origin = vi.fn(async (request: Request) => {
      const range = request.headers.get("range");
      if (range === null) {
        // The background warm fetch asks for the complete object.
        return sourceResponse(video, "video/webm", {
          "accept-ranges": "bytes",
          etag: '"video-v1"',
        });
      }
      expect(range).toBe("bytes=10-19");
      return sourceResponse(
        video.slice(10),
        "video/webm",
        { "accept-ranges": "bytes", "content-range": "bytes 10-19/20" },
        206,
      );
    });
    vi.stubGlobal("fetch", withOrigin(origin));

    const cold = await SELF.fetch(PUBLIC_RESOLVER_URL, {
      headers: { range: "bytes=10-19" },
    });
    expect(cold.status).toBe(206);
    expect(cold.headers.get("content-range")).toBe("bytes 10-19/20");
    expect(cold.headers.get("x-shutter-cache")).toBe("origin");
    // A cold partial must never enter a downstream cache.
    expect(cold.headers.get("cache-control")).toBe("private, no-store");

    await vi.waitFor(() => expect(origin).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      const warm = await SELF.fetch(PUBLIC_RESOLVER_URL, {
        headers: { range: "bytes=10-19" },
      });
      expect(warm.status).toBe(206);
      expect(warm.headers.get("x-shutter-cache")).toBe("edge-hit");
      expect(await warm.text()).toBe("abcdefghij");
    });
    expect(origin).toHaveBeenCalledTimes(2);
  });

  it("serves an If-Range mismatch from the cached complete object", async () => {
    const origin = vi.fn(async () =>
      sourceResponse("0123456789", "video/mp4", {
        "accept-ranges": "bytes",
        etag: '"video-v2"',
        "last-modified": "Wed, 01 Jul 2026 12:00:00 GMT",
      }),
    );
    vi.stubGlobal("fetch", withOrigin(origin));
    expect((await SELF.fetch(PUBLIC_RESOLVER_URL)).status).toBe(200);

    const matching = await SELF.fetch(PUBLIC_RESOLVER_URL, {
      headers: { range: "bytes=2-4", "if-range": '"video-v2"' },
    });
    expect(matching.status).toBe(206);
    expect(await matching.text()).toBe("234");
    expect(matching.headers.get("x-shutter-cache")).toBe("edge-hit");

    const mismatch = await SELF.fetch(PUBLIC_RESOLVER_URL, {
      headers: { range: "bytes=2-4", "if-range": '"video-v1"' },
    });
    expect(mismatch.status).toBe(200);
    expect(await mismatch.text()).toBe("0123456789");
    expect(mismatch.headers.get("x-shutter-cache")).toBe("edge-hit");
    expect(origin).toHaveBeenCalledOnce();
  });

  it("preserves an unsatisfied range and rejects mismatched partial metadata", async () => {
    const origin = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(null, { status: 416, headers: { "content-range": "bytes */100" } }),
      )
      .mockResolvedValueOnce(
        sourceResponse("wrong-span", "video/mp4", { "content-range": "bytes 90-99/100" }, 206),
      )
      .mockResolvedValueOnce(
        sourceResponse(
          "0123456789",
          "video/mp4",
          { "content-length": "9", "content-range": "bytes 5-14/100" },
          206,
        ),
      )
      .mockResolvedValueOnce(
        sourceResponse("short", "video/mp4", { "content-range": "bytes 0-4/100" }, 206),
      );
    vi.stubGlobal("fetch", withOrigin(origin));

    const unsatisfied = await SELF.fetch(PUBLIC_RESOLVER_URL, {
      headers: { range: "bytes=100-110" },
    });
    expect(unsatisfied.status).toBe(416);
    expect(unsatisfied.headers.get("content-range")).toBe("bytes */100");

    const malformed = await SELF.fetch(PUBLIC_RESOLVER_URL, {
      headers: { range: "bytes=5-10" },
    });
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toEqual({ error: { code: "origin_unavailable" } });

    const wrongLength = await SELF.fetch(PUBLIC_RESOLVER_URL, {
      headers: { range: "bytes=5-14" },
    });
    expect(wrongLength.status).toBe(502);
    expect(await wrongLength.json()).toEqual({ error: { code: "origin_unavailable" } });

    const shortSpan = await SELF.fetch(PUBLIC_RESOLVER_URL, {
      headers: { range: "bytes=0-9" },
    });
    expect(shortSpan.status).toBe(502);
    expect(await shortSpan.json()).toEqual({ error: { code: "origin_unavailable" } });
  });

  it("serves a cached PDF conditional response without another origin fetch", async () => {
    const origin = vi.fn(async () =>
      sourceResponse("%PDF-safe", "application/pdf", {
        etag: '"pdf-v1"',
        "last-modified": "Wed, 01 Jul 2026 12:00:00 GMT",
      }),
    );
    vi.stubGlobal("fetch", withOrigin(origin));
    expect((await SELF.fetch(PUBLIC_RESOLVER_URL)).status).toBe(200);

    const conditional = await SELF.fetch(PUBLIC_RESOLVER_URL, {
      headers: { "if-none-match": '"pdf-v1"' },
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("x-shutter-cache")).toBe("edge-hit");
    expect(origin).toHaveBeenCalledOnce();
  });

  it("authorizes every private request before the cache lookup", async () => {
    const sourceId = "private-video";
    const locator = "https://sources.example.com/private/video.mp4?signature=one";
    const token = await deliveryToken("private", sourceId, locator);
    const origin = vi.fn(async () => sourceResponse("private-video", "video/mp4"));
    vi.stubGlobal("fetch", withOrigin(origin));
    const url = `https://edge.shutter.test/v1/private/example-private/delivery/${token}`;

    const first = await SELF.fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("cache-tag")).toBeNull();
    expect(first.headers.get("x-shutter-cache")).toBe("origin");

    const denied = await SELF.fetch(
      `https://edge.shutter.test/v1/private/example-private/delivery/${tamper(token)}`,
    );
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("private-video");
    expect(origin).toHaveBeenCalledOnce();

    const allowed = await SELF.fetch(url);
    expect(allowed.headers.get("x-shutter-cache")).toBe("edge-hit");
    expect(origin).toHaveBeenCalledOnce();
  });

  it("keeps Source Delivery separate from Image Optimization capabilities", async () => {
    const locator = "https://sources.example.com/private/image.jpg";
    const imageToken = await deliveryToken("private", "private-image", locator, 0, "image_source");
    const origin = vi.fn(async () => sourceResponse("image", "image/jpeg"));
    vi.stubGlobal("fetch", withOrigin(origin));

    const response = await SELF.fetch(
      `https://edge.shutter.test/v1/private/example-private/delivery/${imageToken}`,
    );
    expect(response.status).toBe(403);
    expect(origin).not.toHaveBeenCalled();
  });

  it("uses stable Source identity when a public locator rotates", async () => {
    const sourceId = "located-video";
    const firstToken = await deliveryToken(
      "public",
      sourceId,
      "https://sources.example.com/public/video.mp4?signature=one",
    );
    const secondToken = await deliveryToken(
      "public",
      sourceId,
      "https://sources.example.com/public/video.mp4?signature=two",
      12,
    );
    const origin = vi.fn(async () => sourceResponse("stable-video", "video/mp4"));
    vi.stubGlobal("fetch", withOrigin(origin));

    const prefix = `https://edge.shutter.test/v1/public/example-public/delivery/located/${sourceId}/`;
    expect((await SELF.fetch(`${prefix}${firstToken}`)).headers.get("x-shutter-cache")).toBe(
      "origin",
    );
    const rotated = await SELF.fetch(`${prefix}${secondToken}`);
    expect(rotated.headers.get("x-shutter-cache")).toBe("edge-hit");
    expect(await rotated.text()).toBe("stable-video");
    expect(origin).toHaveBeenCalledOnce();
  });

  it("does not cache objects above the Cache API maximum", async () => {
    const origin = vi.fn(async () =>
      sourceResponse("large-image-stream", "image/avif", {
        "content-length": String(512 * 1024 * 1024 + 1),
      }),
    );
    vi.stubGlobal("fetch", withOrigin(origin));

    expect((await SELF.fetch(PUBLIC_RESOLVER_URL)).headers.get("x-shutter-cache")).toBe("origin");
    expect((await SELF.fetch(PUBLIC_RESOLVER_URL)).headers.get("x-shutter-cache")).toBe("origin");
    expect(origin).toHaveBeenCalledTimes(2);
  });

  it("rejects active content, query parameters, and unsupported methods", async () => {
    const origin = vi.fn(async () => sourceResponse("<script>active</script>", "text/html"));
    vi.stubGlobal("fetch", withOrigin(origin));

    const active = await SELF.fetch(PUBLIC_RESOLVER_URL);
    expect(active.status).toBe(415);
    expect(await active.json()).toEqual({ error: { code: "media_unsupported" } });

    const transformed = await SELF.fetch(`${PUBLIC_RESOLVER_URL}?w=640&q=75`);
    expect(transformed.status).toBe(400);
    expect(await transformed.json()).toEqual({ error: { code: "query_invalid" } });

    const multipleRanges = await SELF.fetch(PUBLIC_RESOLVER_URL, {
      headers: { range: "bytes=0-1,4-5" },
    });
    expect(multipleRanges.status).toBe(400);
    expect(await multipleRanges.json()).toEqual({ error: { code: "request_invalid" } });

    const unencodedSourceRef = await SELF.fetch(
      "https://edge.shutter.test/v1/public/example-public/delivery/resolver/uploadthing/example-project/source-01",
    );
    expect(unencodedSourceRef.status).toBe(404);

    const posted = await SELF.fetch(PUBLIC_RESOLVER_URL, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
    expect(origin).toHaveBeenCalledOnce();
  });
});
