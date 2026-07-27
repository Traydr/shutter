import { buildMasterPreviewKey } from "@shutter/protocol";
import { describe, expect, it, vi } from "vitest";
import { createControlApp } from "./app.js";
import type { ControlLogger } from "./logging.js";

const TOKEN = "a".repeat(32);
const IMGPROXY = {
  baseUrl: "http://shutter-imgproxy.railway.internal:8080",
  key: "736563726574",
  salt: "68656c6c6f",
  secret: "s".repeat(32),
};

const NOOP_LOGGER: ControlLogger = { emit() {}, async shutdown() {} };

function spikeUrl(): string {
  const url = new URL("http://shutter.test/internal/v1/spike/rendition");
  url.searchParams.set(
    "key",
    "cache/v1/private/demo-private/gMNnP86xbOKzyOCG34XyJJ5czSTAojiMAnH4AQSdh9s/source/w640-q75.webp",
  );
  url.searchParams.set(
    "source",
    "https://objects.example.com/demo-private-bucket/originals/test.jpg",
  );
  url.searchParams.set("w", "640");
  url.searchParams.set("q", "75");
  return url.href;
}

describe("control app", () => {
  it("rejects direct access to the Railway origin probe", async () => {
    const control = createControlApp({
      logger: NOOP_LOGGER,
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
    const control = createControlApp({
      logger: NOOP_LOGGER,
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

  it("rejects incomplete or malformed rendition requests before imgproxy", async () => {
    const fetch = vi.fn();
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
    });
    const missingSource = await control.request(
      "http://shutter.test/internal/v1/spike/rendition?key=cache/v1/private/demo-private/fp/source/w640-q75.webp&w=640&q=75",
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );

    expect(missingSource.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects origin sources outside the Space allowlist", async () => {
    const fetch = vi.fn();
    const control = createControlApp({
      logger: NOOP_LOGGER,
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

  it("authenticates and strictly validates master rendition requests", async () => {
    const presignGet = vi.fn(async () => "https://r2.example.test/signed-master?signature=secret");
    const fetch = vi.fn(async () => new Response("master", { status: 200 }));
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
      masterStore: { presignGet },
    });
    const url = "http://shutter.test/internal/v1/master-rendition";
    const body = JSON.stringify({
      spaceId: "demo-private",
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
      await buildMasterPreviewKey("demo-private", "source/one", "video"),
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not expose a presigned master URL when imgproxy fails", async () => {
    const signed = "https://r2.example.test/master?X-Amz-Signature=do-not-log";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(async () => new Response(null, { status: 502 })),
      masterStore: { presignGet: async () => signed },
    });
    const response = await control.request("http://shutter.test/internal/v1/master-rendition", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        spaceId: "demo-private",
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

  it("issues a server-generated request ID and ignores caller-controlled ones", async () => {
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });
    const response = await control.request("http://shutter.test/internal/v1/spike/rendition", {
      headers: { "x-request-id": "caller-controlled-secret" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(response.headers.get("x-request-id")).not.toBe("caller-controlled-secret");
  });

  it("contains uncaught failures behind a generic error body", async () => {
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => {
        throw new Error("sentinel-secret-error-message");
      },
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });

    const response = await control.request("http://shutter.test/internal/v1/spike/rendition");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: { code: "service_unavailable" } });
    expect(body).not.toContain("sentinel-secret-error-message");
  });
});
