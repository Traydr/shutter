import {
  buildMasterPreviewKey,
  buildOptimizeSourceQuery,
  parseEdgeConfigSnapshot,
} from "@shutter/protocol";
import { describe, expect, it, vi } from "vitest";
import { createControlApp } from "./app.js";
import { EdgeRefreshTracker } from "./edge-refresh-status.js";
import type { ControlLogger } from "./logging.js";
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

describe("control app", () => {
  it("rejects direct access to the Railway origin probe", async () => {
    const control = createControlApp({
      logger: NOOP_LOGGER,
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
    const control = createControlApp({
      logger: NOOP_LOGGER,
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
    const control = createControlApp({
      logger: NOOP_LOGGER,
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

  it("returns unavailable when Postgres is not configured", async () => {
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });
    const optimization = await control.request(spikeUrl(), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const job = await control.request(
      "http://shutter.test/v1/spaces/example-private/sources/source/previews/video",
    );

    expect(optimization.status).toBe(503);
    expect(job.status).toBe(503);
    expect(job.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects origin sources outside the Space allowlist", async () => {
    const fetch = vi.fn();
    const control = createControlApp({
      logger: NOOP_LOGGER,
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
    const control = createControlApp({
      logger: NOOP_LOGGER,
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
    const control = createControlApp({
      logger: NOOP_LOGGER,
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

  it("issues a server-generated request ID and ignores caller-controlled ones", async () => {
    const control = createControlApp({
      logger: NOOP_LOGGER,
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });
    const response = await control.request("http://shutter.test/internal/v1/optimize-source", {
      headers: { "x-request-id": "caller-controlled-secret" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(response.headers.get("x-request-id")).not.toBe("caller-controlled-secret");
  });

  it("serves one authenticated, non-cacheable Edge configuration snapshot", async () => {
    const registry = new MemorySpaceRegistry({
      spaces: [
        {
          id: "example-private",
          routeClass: "private",
          qualities: [75],
          defaultQuality: 75,
          allowedSourceOrigins: [{ origin: "https://sources.example.com" }],
          resolvers: [],
        },
      ],
    });
    await registry.addCapabilityKey(
      "example-private",
      "test-key",
      Uint8Array.from({ length: 32 }, (_, index) => index),
    );
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => TOKEN,
      edgeConfigToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
      spaceRegistry: registry,
    });
    const url = "https://shutter.test/internal/v1/edge/config";
    expect((await control.request(url)).status).toBe(401);

    const response = await control.request(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const snapshot = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(snapshot).toMatchObject({ schemaVersion: "v1", generation: 1 });
    expect(snapshot.spaces).toEqual([expect.objectContaining({ id: "example-private" })]);
    expect(snapshot.capabilityKeys).toEqual({
      "example-private": {
        "test-key": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      },
    });
  });

  it("records authenticated Edge refresh reports for the admin surface", async () => {
    const tracker = new EdgeRefreshTracker(() => new Date("2026-08-11T12:00:00.000Z"));
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => TOKEN,
      edgeConfigToken: () => TOKEN,
      edgeRefreshTracker: tracker,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
      spaceRegistry: SPACE_REGISTRY,
    });
    const url = "https://shutter.test/internal/v1/edge/config/refresh";
    expect(
      (
        await control.request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: 4 }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await control.request(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ generation: 4, extra: true }),
        })
      ).status,
    ).toBe(400);
    const accepted = await control.request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ generation: 4 }),
    });
    expect(accepted.status).toBe(204);
    expect(tracker.latest()).toEqual({
      generation: 4,
      refreshedAt: new Date("2026-08-11T12:00:00.000Z"),
    });
  });

  it("mounts the separately authenticated admin application", async () => {
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => TOKEN,
      adminBootstrapToken: () => "admin_bootstrap_token_abcdefghijklmnopqrstuvwxyz",
      imgproxyAllowedSources: () => "https://sources.example.com",
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
      spaceRegistry: SPACE_REGISTRY,
    });
    const response = await control.request("https://shutter.test/admin");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Manage Spaces");
  });

  it("creates a Space through admin, observes Edge refresh, and renders without code configuration", async () => {
    const registry = new MemorySpaceRegistry();
    const tracker = new EdgeRefreshTracker(() => new Date("2026-08-11T12:00:00.000Z"));
    const adminToken = "admin_bootstrap_token_abcdefghijklmnopqrstuvwxyz";
    const fetch = vi.fn(
      async () =>
        new Response(Uint8Array.from([82, 73, 70, 70]), {
          headers: { "content-type": "image/webp" },
        }),
    );
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => TOKEN,
      edgeConfigToken: () => TOKEN,
      adminBootstrapToken: () => adminToken,
      imgproxyAllowedSources: () => "https://sources.example.com",
      edgeRefreshTracker: tracker,
      imgproxyConfig: () => IMGPROXY,
      fetch,
      spaceRegistry: registry,
    });
    const login = await control.request("https://shutter.test/admin/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: adminToken }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const dashboard = await control.request("https://shutter.test/admin", {
      headers: { cookie },
    });
    const csrf = /name="csrf" value="([^"]+)"/u.exec(await dashboard.text())?.[1] ?? "";
    const created = await control.request("https://shutter.test/admin/spaces", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://shutter.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf,
        spaceId: "admin-created",
        routeClass: "public",
        qualities: "75",
        defaultQuality: "75",
        allowedSourceOrigins: "https://sources.example.com/media",
        resolvers: "",
      }),
    });
    expect(created.status).toBe(303);

    const snapshotResponse = await control.request("https://shutter.test/internal/v1/edge/config", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const snapshot = parseEdgeConfigSnapshot(await snapshotResponse.json());
    expect(snapshot.policyFor("admin-created")).toBeDefined();
    expect(
      (
        await control.request("https://shutter.test/internal/v1/edge/config/refresh", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ generation: snapshot.generation }),
        })
      ).status,
    ).toBe(204);

    const deliveryUrl = new URL("https://shutter.test/internal/v1/optimize-source");
    deliveryUrl.search = buildOptimizeSourceQuery({
      spaceId: "admin-created",
      sourceUrl: "https://sources.example.com/media/image.jpg",
      width: 640,
      quality: 75,
    }).toString();
    const optimization = await control.request(deliveryUrl, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(optimization.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();

    const refreshedDashboard = await control.request("https://shutter.test/admin", {
      headers: { cookie },
    });
    const refreshedBody = await refreshedDashboard.text();
    expect(refreshedBody).toContain("Latest Edge refresh");
    expect(refreshedBody).toContain(
      `Registry generation</div><div class="metric">${snapshot.generation}`,
    );
  });

  it("contains uncaught failures behind a generic error body", async () => {
    const control = createControlApp({
      logger: NOOP_LOGGER,
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => {
        throw new Error("sentinel-secret-error-message");
      },
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });

    const response = await control.request("http://shutter.test/internal/v1/optimize-source");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: { code: "internal_error" } });
    expect(body).not.toContain("sentinel-secret-error-message");
  });
});
