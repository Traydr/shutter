import { buildMasterPreviewKey, buildOptimizeSourceQuery } from "@shutter/protocol";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ControlRuntimeConfig } from "./app.js";
import type { ControlLogger } from "./logging.js";
import { registerOptimizeRoutes } from "./optimize-routes.js";
import { MemorySpaceRegistry } from "./spaces/memory-registry.js";

const TOKEN = "a".repeat(32);
const IMGPROXY = {
  baseUrl: "http://shutter-imgproxy.railway.internal:8080",
  key: "736563726574",
  salt: "68656c6c6f",
  secret: "s".repeat(32),
};

const NOOP_LOGGER: ControlLogger = { emit() {}, async shutdown() {} };
const SPACE_REGISTRY = new MemorySpaceRegistry({
  spaces: [
    {
      id: "example-private",
      routeClass: "private",
      qualities: [75],
      defaultQuality: 75,
      allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/private" }],
      resolvers: [],
    },
  ],
});

function optimizeApp(runtime: Omit<ControlRuntimeConfig, "logger"> & { logger?: ControlLogger }) {
  const app = new Hono<{ Variables: { requestId: string } }>();
  registerOptimizeRoutes(app, { logger: NOOP_LOGGER, ...runtime });
  return app;
}

function spikeUrl(): string {
  const url = new URL("http://shutter.test/internal/v1/optimize-source");
  url.search = buildOptimizeSourceQuery({
    spaceId: "example-private",
    sourceUrl: "https://sources.example.com/private/originals/test.jpg",
    width: 640,
    quality: 75,
  }).toString();
  return url.href;
}

describe("optimize routes", () => {
  it("rejects direct access to the Railway origin probe", async () => {
    const control = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });
    const url = spikeUrl();

    const missing = await control.request(url);
    const wrong = await control.request(url, {
      headers: { authorization: `Bearer ${"b".repeat(32)}` },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves only a valid cache probe to the Worker credential", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(Uint8Array.from([82, 73, 70, 70]), {
          headers: { "content-type": "image/webp" },
        }),
    );
    const control = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
    });
    const response = await control.request(spikeUrl(), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toMatch(
      /^http:\/\/shutter-imgproxy\.railway\.internal:8080\/[A-Za-z0-9_-]{43}\/rs:fit:640:0:0\/q:75\/[A-Za-z0-9_-]+\.webp$/u,
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${IMGPROXY.secret}`);
  });

  it("rejects incomplete or malformed optimization requests before imgproxy", async () => {
    const fetch = vi.fn();
    const control = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
    });
    const missingSource = await control.request(
      "http://shutter.test/internal/v1/optimize-source?space=example-private&w=640&q=75",
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const missingSpace = await control.request(
      "http://shutter.test/internal/v1/optimize-source?source=https://sources.example.com/private/originals/test.jpg&w=640&q=75",
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const extraParameter = await control.request(`${spikeUrl()}&key=legacy-cache-key`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(missingSource.status).toBe(400);
    expect(missingSpace.status).toBe(400);
    expect(extraParameter.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects origin sources outside the Space allowlist", async () => {
    const fetch = vi.fn();
    const control = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
    });
    const url = new URL(spikeUrl());
    url.searchParams.set("source", "https://evil.example/object.jpg");
    const response = await control.request(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "locator_not_allowed" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("authenticates and strictly validates optimize-master requests", async () => {
    const presignGet = vi.fn(async () => "https://r2.example.test/signed-master?signature=secret");
    const fetch = vi.fn(async () => new Response("master", { status: 200 }));
    const control = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
      masterStore: { presignGet },
    });
    const url = "http://shutter.test/internal/v1/optimize-master";
    const body = JSON.stringify({
      spaceId: "example-private",
      sourceId: "source/one",
      kind: "video",
      w: 640,
      q: 75,
    });

    expect((await control.request(url, { method: "POST" })).status).toBe(401);
    expect(
      (
        await control.request(url, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ ...JSON.parse(body), key: "masters/caller-selected" }),
        })
      ).status,
    ).toBe(400);

    const response = await control.request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    expect(presignGet).toHaveBeenCalledWith(
      await buildMasterPreviewKey("example-private", "source/one", "video"),
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not expose a presigned master URL when imgproxy fails", async () => {
    const signed = "https://r2.example.test/master?X-Amz-Signature=do-not-log";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const control = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(async () => new Response(null, { status: 502 })),
      masterStore: { presignGet: async () => signed },
    });
    const response = await control.request("http://shutter.test/internal/v1/optimize-master", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        spaceId: "example-private",
        sourceId: "one",
        kind: "pdf",
        w: 640,
        q: 75,
      }),
    });
    expect(response.status).toBe(502);
    expect(JSON.stringify(error.mock.calls)).not.toContain(signed);
    error.mockRestore();
  });

  it("answers 503 for a Space the registry does not know how to serve", async () => {
    const fetch = vi.fn();
    const noImgproxy = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => undefined,
      fetch,
    });
    const noRegistry = optimizeApp({
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
    });
    const noMasterStore = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
    });
    const headers = { authorization: `Bearer ${TOKEN}` };
    expect((await noImgproxy.request(spikeUrl(), { headers })).status).toBe(503);
    expect((await noRegistry.request(spikeUrl(), { headers })).status).toBe(503);
    const master = await noMasterStore.request("http://shutter.test/internal/v1/optimize-master", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        spaceId: "example-private",
        sourceId: "one",
        kind: "pdf",
        w: 640,
        q: 75,
      }),
    });
    expect(master.status).toBe(503);
    const unknownSpace = new URL(spikeUrl());
    unknownSpace.searchParams.set("space", "unknown-space");
    const missing = await optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
    }).request(unknownSpace, { headers });
    expect(missing.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
