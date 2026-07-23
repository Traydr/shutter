import { buildMasterPreviewKey, type OperationalEvent } from "@shutter/protocol";
import { describe, expect, it, vi } from "vitest";
import { app, createControlApp } from "./app.js";
import type { ControlLogger, OperationalLogLevel } from "./logging.js";

const TOKEN = "a".repeat(32);
const IMGPROXY = {
  baseUrl: "http://shutter-imgproxy.railway.internal:8080",
  key: "736563726574",
  salt: "68656c6c6f",
  secret: "s".repeat(32),
};

const NOOP_LOGGER: ControlLogger = { emit() {}, async shutdown() {} };

function recordingLogger(): {
  logger: ControlLogger;
  records: Array<{ level: OperationalLogLevel; event: OperationalEvent }>;
} {
  const records: Array<{ level: OperationalLogLevel; event: OperationalEvent }> = [];
  return {
    logger: {
      emit(level, event) {
        records.push({ level, event });
      },
      async shutdown() {},
    },
    records,
  };
}

function spikeUrl(): string {
  const url = new URL("http://shutter.test/internal/v1/spike/rendition");
  url.searchParams.set(
    "key",
    "cache/v1/private/pane-view/N9NjtQwUp8dMa1ZiHnNJoAhg7-DZ-KOSehNDho5dYKs/source/w640-q75.webp",
  );
  url.searchParams.set(
    "source",
    "https://t3.storageapi.dev/balanced-wrap-ocyiwwexhao/originals/test.jpg",
  );
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
      "http://shutter.test/internal/v1/spike/rendition?key=cache/v1/private/pane-view/fp/source/w640-q75.webp&w=640&q=75",
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
      spaceId: "pane-view",
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
      await buildMasterPreviewKey("pane-view", "source/one", "video"),
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
      body: JSON.stringify({ spaceId: "pane-view", sourceId: "one", kind: "pdf", w: 640, q: 75 }),
    });
    expect(response.status).toBe(502);
    expect(JSON.stringify(error.mock.calls)).not.toContain(signed);
    error.mockRestore();
  });

  it("logs one safe completion record and returns a server-generated request ID", async () => {
    const { logger, records } = recordingLogger();
    const control = createControlApp({
      logger,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });
    const rawUrl =
      "http://shutter.test/internal/v1/spike/rendition?source=https%3A%2F%2Fsecret.example%2Fobject&token=do-not-log";
    const response = await control.request(rawUrl, {
      headers: { "x-request-id": "caller-controlled-secret" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(response.headers.get("x-request-id")).not.toBe("caller-controlled-secret");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "info",
      event: {
        event: "control.http.completed",
        httpMethod: "GET",
        httpRoute: "/internal/v1/spike/rendition",
        httpStatusCode: 401,
        outcome: "failed",
      },
    });
    expect(records[0]?.event.requestId).toBe(response.headers.get("x-request-id"));
    expect(records[0]?.event.durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(records)).not.toContain("secret.example");
    expect(JSON.stringify(records)).not.toContain("caller-controlled-secret");
    expect(JSON.stringify(records)).not.toContain("do-not-log");
  });

  it("omits health checks and uses a safe literal for unmatched routes", async () => {
    const { logger, records } = recordingLogger();
    const control = createControlApp({
      logger,
      originAuthToken: () => undefined,
      imgproxyConfig: () => undefined,
      fetch: vi.fn(),
    });

    await control.request("http://shutter.test/healthz?probe=secret");
    const missing = await control.request("http://shutter.test/raw/source-id?token=secret");

    expect(missing.status).toBe(404);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "info",
      event: { event: "control.http.completed", httpRoute: "<unmatched>", httpStatusCode: 404 },
    });
    expect(JSON.stringify(records)).not.toContain("source-id");
    expect(JSON.stringify(records)).not.toContain("token=secret");
  });

  it("logs mounted job routes as templates without raw Source IDs", async () => {
    const { logger, records } = recordingLogger();
    const control = createControlApp({
      logger,
      originAuthToken: () => undefined,
      imgproxyConfig: () => undefined,
      fetch: vi.fn(),
      jobApiRuntime: {
        logger,
        lifecycle: {} as never,
        now: () => new Date("2026-07-23T00:00:00Z"),
        spaceApiTokens: () => new Map(),
        capabilityKeys: () => new Map(),
        executorToken: () => undefined,
        dispatch: vi.fn(async () => {}),
      },
    });

    const response = await control.request(
      "http://shutter.test/v1/spaces/pane-view/sources/private-source-id/previews/video",
    );

    expect(response.status).toBe(401);
    expect(records).toHaveLength(1);
    expect(records[0]?.event.httpRoute).toBe(
      "/v1/spaces/:spaceId/sources/:sourceId/previews/:kind",
    );
    expect(JSON.stringify(records)).not.toContain("private-source-id");
  });

  it("contains uncaught failures without logging their message or stack", async () => {
    const { logger, records } = recordingLogger();
    const control = createControlApp({
      logger,
      originAuthToken: () => {
        throw new Error("sentinel-secret-error-message");
      },
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });

    const response = await control.request("http://shutter.test/internal/v1/spike/rendition");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: { code: "service_unavailable" } });
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          event: expect.objectContaining({ event: "control.service.failed", errorType: "Error" }),
        }),
        expect.objectContaining({
          level: "error",
          event: expect.objectContaining({
            event: "control.http.completed",
            httpStatusCode: 500,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("sentinel-secret-error-message");
    expect(JSON.stringify(records)).not.toContain("stack");
  });
});
