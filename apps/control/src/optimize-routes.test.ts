import {
  buildMasterPreviewKey,
  buildOptimizeSourceQuery,
  type JsonObject,
  type SpacePolicy,
} from "@shutter/protocol";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ControlRuntimeConfig } from "./app.js";
import type { ControlLogger } from "./logging.js";
import { registerOptimizeRoutes } from "./optimize-routes.js";
import { createSourceResolverService } from "./source-resolvers.js";
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

describe("v2 optimize and resolve wire", () => {
  const publicPolicy: SpacePolicy = {
    id: "example-public",
    routeClass: "public",
    qualities: [75],
    defaultQuality: 75,
    allowedSourceOrigins: [
      { origin: "https://example-project.ufs.sh", pathPrefix: "/f" },
      { origin: "https://objects.example.test", pathPrefix: "/example-bucket" },
    ],
    resolvers: [
      {
        id: "ut",
        type: "template",
        url: "https://{project}.ufs.sh/f/{file}",
        placeholders: { project: { allowed: ["example-project"] }, file: {} },
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
  };

  async function v2App(options: { credential?: boolean } = {}) {
    const registry = new MemorySpaceRegistry();
    await registry.createSpace(publicPolicy, [
      { resolverId: "media", accessKeyId: "AKIA", secretAccessKey: "s" },
    ]);
    const presigned: string[] = [];
    const sourceResolvers = createSourceResolverService({
      // A credential that cannot be opened is the one configuration error the
      // registry cannot prevent at write time.
      credentials:
        options.credential === false ? { getResolverCredential: async () => undefined } : registry,
      presigner: {
        presign: async ({ key, expiresInSeconds }) => {
          presigned.push(`${key} ${expiresInSeconds}`);
          return `https://objects.example.test/example-bucket/${key}?X-Amz-Signature=sealed`;
        },
      },
    });
    const fetch = vi.fn(
      async () => new Response("webp", { headers: { "content-type": "image/webp" } }),
    );
    const control = optimizeApp({
      spaceRegistry: registry,
      sourceResolvers,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      masterStore: { presignGet: async (key) => `https://masters.example.test/${key}` },
      fetch,
    });
    return { control, fetch, presigned };
  }

  function post(control: Hono, path: string, body: string, authorized = true) {
    const headers = new Headers({ "content-type": "application/json" });
    if (authorized) headers.set("authorization", `Bearer ${TOKEN}`);
    return control.request(`http://shutter.test${path}`, { method: "POST", headers, body });
  }

  it("optimizes a resolved S3 input through a presigned locator that stays inside Control", async () => {
    const { control, fetch, presigned } = await v2App();
    const response = await post(
      control,
      "/internal/v2/optimize",
      JSON.stringify({
        spaceId: "example-public",
        input: { type: "resolved", resolverId: "media", reference: ["file.one"] },
        width: 640,
        quality: 75,
      }),
    );
    expect(response.status).toBe(200);
    expect(presigned).toEqual(["originals/file.one 600"]);
    const [url] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/^http:\/\/shutter-imgproxy\.railway\.internal:8080\//u);
    expect(String(url)).not.toContain("X-Amz-Signature");
  });

  it("answers each resolution failure with its own status", async () => {
    const { control } = await v2App({ credential: false });
    const request = (input: JsonObject) =>
      post(
        control,
        "/internal/v2/optimize",
        JSON.stringify({ spaceId: "example-public", input, width: 640, quality: 75 }),
      );
    expect((await request({ type: "resolved", resolverId: "nope", reference: ["x"] })).status).toBe(
      404,
    );
    expect(
      (await request({ type: "resolved", resolverId: "ut", reference: ["other", "x"] })).status,
    ).toBe(404);
    expect(
      (await request({ type: "resolved", resolverId: "media", reference: ["x"] })).status,
    ).toBe(503);
    expect(
      (await request({ type: "located", sourceUrl: "https://elsewhere.example/x" })).status,
    ).toBe(403);
    expect((await request({ type: "callback", url: "https://x" })).status).toBe(400);
    expect((await post(control, "/internal/v2/optimize", JSON.stringify({}), false)).status).toBe(
      401,
    );
  });

  it("presigns a delivery locator for the Edge and never stores it", async () => {
    const { control, presigned } = await v2App();
    const response = await post(
      control,
      "/internal/v2/resolve",
      JSON.stringify({ spaceId: "example-public", resolverId: "media", reference: ["clip.mp4"] }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      locator:
        "https://objects.example.test/example-bucket/originals/clip.mp4?X-Amz-Signature=sealed",
    });
    expect(presigned).toEqual(["originals/clip.mp4 600"]);
    const template = await post(
      control,
      "/internal/v2/resolve",
      JSON.stringify({
        spaceId: "example-public",
        resolverId: "ut",
        reference: ["example-project", "f"],
      }),
    );
    expect(await template.json()).toMatchObject({
      locator: "https://example-project.ufs.sh/f/f",
    });
    expect(
      (
        await post(
          control,
          "/internal/v2/resolve",
          JSON.stringify({ spaceId: "missing", resolverId: "ut", reference: ["x"] }),
        )
      ).status,
    ).toBe(404);
    expect((await post(control, "/internal/v2/resolve", "{}", false)).status).toBe(401);
  });
});
