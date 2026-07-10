import { describe, expect, it } from "vitest";
import { app, createControlApp } from "./app.js";

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
    const control = createControlApp({ originAuthToken: () => "a".repeat(32) });
    const url = "http://shutter.test/internal/v1/spike/rendition?key=cache/v1/private/test.webp";

    const missing = await control.request(url);
    const wrong = await control.request(url, {
      headers: { authorization: `Bearer ${"b".repeat(32)}` },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves only a valid cache probe to the Worker credential", async () => {
    const token = "a".repeat(32);
    const control = createControlApp({ originAuthToken: () => token });
    const response = await control.request(
      "http://shutter.test/internal/v1/spike/rendition?key=cache/v1/private/test.webp",
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
