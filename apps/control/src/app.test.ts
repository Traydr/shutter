import { type EdgeConfigSnapshotWire, parseEdgeConfigSnapshot } from "@shutter/protocol";
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

const OPTIMIZE_URL = "http://shutter.test/internal/v2/optimize";

function optimizeInit(spaceId: string, sourceUrl: string, authorized = true): RequestInit {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorized) headers.set("authorization", `Bearer ${TOKEN}`);
  return {
    method: "POST",
    headers,
    body: JSON.stringify({
      spaceId,
      input: { type: "located", sourceUrl },
      width: 640,
      quality: 75,
    }),
  };
}

describe("control app", () => {
  it("returns unavailable when Postgres is not configured", async () => {
    const control = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });
    const optimization = await control.request(
      OPTIMIZE_URL,
      optimizeInit("example-private", "https://sources.example.com/private/originals/test.jpg"),
    );
    const job = await control.request(
      "http://shutter.test/v1/spaces/example-private/sources/source/previews/video",
    );

    const v2Job = await control.request(
      "http://shutter.test/v2/spaces/example-public/sources/media%2Fx/previews/video",
    );

    expect(optimization.status).toBe(503);
    expect(job.status).toBe(503);
    expect(job.headers.get("cache-control")).toBe("private, no-store");
    expect(v2Job.status).toBe(503);
    expect(v2Job.headers.get("content-type")).toBe("application/problem+json");
    await expect(v2Job.json()).resolves.toMatchObject({
      code: "service_unavailable",
      requestId: expect.any(String),
    });
  });

  it("issues a server-generated request ID and ignores caller-controlled ones", async () => {
    const control = createControlApp({
      logger: NOOP_LOGGER,
      spaceRegistry: SPACE_REGISTRY,
      originAuthToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
    });
    const response = await control.request(OPTIMIZE_URL, {
      method: "POST",
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
    const snapshot: EdgeConfigSnapshotWire = await response.json();

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
    expect(await response.text()).toContain("Bootstrap token");
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

    const optimization = await control.request(
      "https://shutter.test/internal/v2/optimize",
      optimizeInit("admin-created", "https://sources.example.com/media/image.jpg"),
    );
    expect(optimization.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();

    const refreshedDashboard = await control.request("https://shutter.test/admin", {
      headers: { cookie },
    });
    const refreshedBody = await refreshedDashboard.text();
    expect(refreshedBody).toContain("Latest Edge refresh");
    expect(refreshedBody).toContain(
      `Registry generation <span class="num">${snapshot.generation}</span>`,
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

    const response = await control.request(OPTIMIZE_URL, { method: "POST" });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: { code: "internal_error" } });
    expect(body).not.toContain("sentinel-secret-error-message");
  });
});

describe("control app admin API", () => {
  it("mounts the admin routes, logs their templates, and answers unknown admin paths as problems", async () => {
    const emit = vi.fn();
    const control = createControlApp({
      logger: { emit, async shutdown() {} },
      originAuthToken: () => TOKEN,
      adminApiToken: () => TOKEN,
      imgproxyConfig: () => IMGPROXY,
      fetch: vi.fn(),
      spaceRegistry: new MemorySpaceRegistry(),
      edgeRefreshTracker: new EdgeRefreshTracker(),
    });
    const headers = { authorization: `Bearer ${TOKEN}` };

    const overview = await control.request("http://shutter.test/v1/admin/overview", { headers });
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toMatchObject({ generation: 0, spaces: [] });
    expect(emit).toHaveBeenLastCalledWith(
      "info",
      expect.objectContaining({
        event: "control.http.completed",
        httpRoute: "/v1/admin/overview",
        httpStatusCode: 200,
      }),
    );

    const missing = await control.request("http://shutter.test/v1/admin/spaces/nobody", {
      headers,
    });
    expect(missing.status).toBe(404);
    expect(emit).toHaveBeenLastCalledWith(
      "info",
      expect.objectContaining({ httpRoute: "/v1/admin/spaces/:spaceId", httpStatusCode: 404 }),
    );

    const unknown = await control.request("http://shutter.test/v1/admin/nothing", { headers });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toBe("application/problem+json");
    await expect(unknown.json()).resolves.toMatchObject({
      code: "not_found",
      requestId: expect.any(String),
    });
    expect(emit).toHaveBeenLastCalledWith(
      "info",
      expect.objectContaining({ httpRoute: "<unmatched>", httpStatusCode: 404 }),
    );
  });
});
