import { describe, expect, it, vi } from "vitest";
import { app, createControlApp } from "./app.js";

const TOKEN = "a".repeat(32);
const IMGPROXY = {
  baseUrl: "http://shutter-imgproxy.railway.internal:8080",
  key: "736563726574",
  salt: "68656c6c6f",
  secret: "s".repeat(32),
};

function spikeUrl(): string {
  const url = new URL("http://shutter.test/internal/v1/spike/rendition");
  url.searchParams.set("key", "cache/v1/public/test.webp");
  url.searchParams.set("source", "https://t3.storageapi.dev/balanced-wrap-ocyiwwexhao/test.jpg");
  url.searchParams.set("w", "640");
  url.searchParams.set("q", "75");
  return url.href;
}

describe("control app", () => {
  it("reports its health", async () => {
    const response = await app.request("http://shutter.test/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "control" });
  });

  it("keeps unimplemented v1 routes closed", async () => {
    const response = await app.request("http://shutter.test/v1/spaces/ernesta");
    expect(response.status).toBe(404);
  });

  it("rejects direct access to the Railway origin probe", async () => {
    const control = createControlApp({
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
    const fetch = vi.fn(async () =>
      new Response(Uint8Array.from([82, 73, 70, 70]), {
        headers: { "content-type": "image/webp" },
      }),
    );
    const control = createControlApp({
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
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch,
    });
    const missingSource = await control.request(
      "http://shutter.test/internal/v1/spike/rendition?key=cache/v1/public/test.webp&w=640&q=75",
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );

    expect(missingSource.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
