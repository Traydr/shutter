import { buildMasterPreviewKey, type JsonObject, type SpacePolicy } from "@shutter/protocol";
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

const OPTIMIZE_URL = "http://shutter.test/internal/v2/optimize";

/** A located input as the v1 Edge routes send it, for the private fixture Space. */
function locatedBody(sourceUrl = "https://sources.example.com/private/originals/test.jpg"): string {
  return JSON.stringify({
    spaceId: "example-private",
    input: { type: "located", sourceUrl },
    width: 640,
    quality: 75,
  });
}

function masterBody(sourceId = "source/one", kind = "video"): string {
  return JSON.stringify({
    spaceId: "example-private",
    input: { type: "master", sourceId, kind },
    width: 640,
    quality: 75,
  });
}

function optimizeRequest(
  control: Hono,
  body: string,
  options: { authorized?: boolean; contentType?: string } = {},
) {
  const headers = new Headers({ "content-type": options.contentType ?? "application/json" });
  if (options.authorized !== false) headers.set("authorization", `Bearer ${TOKEN}`);
  return control.request(OPTIMIZE_URL, { method: "POST", headers, body });
}

describe("optimize routes", () => {
  it("rejects direct access to the Railway origin", async () => {
    const control = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });
    const missing = await optimizeRequest(control, locatedBody(), { authorized: false });
    const wrong = await control.request(OPTIMIZE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${"b".repeat(32)}`, "content-type": "application/json" },
      body: locatedBody(),
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves a located input to the Worker credential through a signed imgproxy request", async () => {
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
    const response = await optimizeRequest(control, locatedBody());

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
    const missingInput = await optimizeRequest(
      control,
      JSON.stringify({ spaceId: "example-private", width: 640, quality: 75 }),
    );
    const missingSpace = await optimizeRequest(
      control,
      JSON.stringify({
        input: { type: "located", sourceUrl: "https://s/x" },
        width: 640,
        quality: 75,
      }),
    );
    const extraField = await optimizeRequest(
      control,
      JSON.stringify({ ...JSON.parse(locatedBody()), key: "legacy-cache-key" }),
    );
    const wrongContentType = await optimizeRequest(control, locatedBody(), {
      contentType: "text/plain",
    });

    expect(missingInput.status).toBe(400);
    expect(missingSpace.status).toBe(400);
    expect(extraField.status).toBe(400);
    expect(wrongContentType.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects located sources outside the Space allowlist", async () => {
    const fetch = vi.fn();
    const control = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
    });
    const response = await optimizeRequest(control, locatedBody("https://evil.example/object.jpg"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "locator_not_allowed" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("presigns the stored master for a master input and validates it strictly", async () => {
    const presignGet = vi.fn(async () => "https://r2.example.test/signed-master?signature=secret");
    const fetch = vi.fn(async () => new Response("master", { status: 200 }));
    const control = optimizeApp({
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
      masterStore: { presignGet },
    });

    expect((await optimizeRequest(control, masterBody(), { authorized: false })).status).toBe(401);
    expect(
      (
        await optimizeRequest(
          control,
          JSON.stringify({
            ...JSON.parse(masterBody()),
            input: { type: "master", sourceId: "source/one", kind: "video", key: "caller" },
          }),
        )
      ).status,
    ).toBe(400);

    const response = await optimizeRequest(control, masterBody());
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
    const response = await optimizeRequest(control, masterBody("one", "pdf"));
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
    expect((await optimizeRequest(noImgproxy, locatedBody())).status).toBe(503);
    expect((await optimizeRequest(noRegistry, locatedBody())).status).toBe(503);
    expect((await optimizeRequest(noMasterStore, masterBody())).status).toBe(503);
    expect(
      (
        await optimizeRequest(
          noMasterStore,
          JSON.stringify({ ...JSON.parse(locatedBody()), spaceId: "missing" }),
        )
      ).status,
    ).toBe(404);
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
