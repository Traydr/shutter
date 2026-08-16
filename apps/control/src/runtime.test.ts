import { describe, expect, it, vi } from "vitest";
import { createServerEnv } from "./env/server.js";
import type { ControlLogger } from "./logging.js";
import { buildControlRuntime, featureReport } from "./runtime.js";

const NOOP_LOGGER: ControlLogger = { emit() {}, async shutdown() {} };
const TOKEN = "t".repeat(40);

const FULL_ENVIRONMENT = {
  DATABASE_URL: "postgres://shutter:secret@localhost:5432/shutter",
  SHUTTER_ENCRYPTION_KEY: "a".repeat(64),
  EDGE_CONFIG_TOKEN: TOKEN,
  ADMIN_BOOTSTRAP_TOKEN: TOKEN,
  S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  S3_BUCKET: "shutter-media",
  S3_ACCESS_KEY_ID: "access",
  S3_SECRET_ACCESS_KEY: "secret",
  CLOUDFLARE_ZONE_ID: "zone",
  CLOUDFLARE_CACHE_PURGE_TOKEN: TOKEN,
  EDGE_BASE_URL: "https://edge.example.test",
  ORIGIN_AUTH_TOKEN: TOKEN,
  IMGPROXY_BASE_URL: "http://imgproxy.internal:8080",
  IMGPROXY_KEY: "736563726574",
  IMGPROXY_SALT: "68656c6c6f",
  IMGPROXY_SECRET: TOKEN,
  VIDEO_EXECUTOR_BASE_URL: "http://video.internal:3000",
  VIDEO_EXECUTOR_TOKEN: TOKEN,
  PDF_EXECUTOR_BASE_URL: "http://pdf.internal:3000",
  PDF_EXECUTOR_TOKEN: TOKEN,
};

function build(environment: Record<string, string | undefined>) {
  return buildControlRuntime(createServerEnv(environment), {
    logger: NOOP_LOGGER,
    fetch: vi.fn(),
    now: () => new Date("2026-08-15T12:00:00.000Z"),
  });
}

function without(...names: (keyof typeof FULL_ENVIRONMENT)[]) {
  const environment: Record<string, string | undefined> = { ...FULL_ENVIRONMENT };
  for (const name of names) delete environment[name];
  return environment;
}

describe("control runtime", () => {
  it("resolves every feature ready from a full environment", async () => {
    const runtime = build(FULL_ENVIRONMENT);
    expect(Object.values(runtime.features).every((status) => status === "ready")).toBe(true);
    expect(runtime.jobApiRuntime).toBeDefined();
    expect(runtime.jobApiRuntime?.sourcePurge).toBeDefined();
    expect(runtime.jobApiRuntime?.executorToken("video")).toBe(TOKEN);
    expect(runtime.config.spaceRegistry).toBeDefined();
    expect(runtime.config.masterStore).toBeDefined();
    expect(runtime.config.imgproxyConfig()).toMatchObject({
      baseUrl: "http://imgproxy.internal:8080",
    });
    expect(featureReport(runtime.features)).toEqual({ count: 0 });
    await runtime.close();
  });

  it("disables the database-backed features without DATABASE_URL", async () => {
    const runtime = build(without("DATABASE_URL"));
    expect(runtime.jobApiRuntime).toBeUndefined();
    expect(runtime.config.spaceRegistry).toBeUndefined();
    expect(runtime.config.jobApiRuntime).toBeUndefined();
    expect(runtime.features).toMatchObject({
      spaceRegistry: { missing: ["DATABASE_URL"] },
      jobApi: { missing: ["DATABASE_URL"] },
      sourcePurge: { missing: ["DATABASE_URL"] },
      edgeConfig: { missing: ["DATABASE_URL"] },
      admin: { missing: ["DATABASE_URL"] },
      masterStore: "ready",
      imgproxy: "ready",
      executorDispatch: "ready",
    });
    expect(featureReport(runtime.features)).toEqual({
      count: 5,
      features:
        "spaceRegistry=DATABASE_URL jobApi=DATABASE_URL edgeConfig=DATABASE_URL admin=DATABASE_URL sourcePurge=DATABASE_URL",
    });
    await runtime.close();
  });

  it("does not build a registry that could not open Capability Keys", async () => {
    const runtime = build(without("SHUTTER_ENCRYPTION_KEY"));
    expect(runtime.config.spaceRegistry).toBeUndefined();
    expect(runtime.jobApiRuntime).toBeUndefined();
    expect(runtime.features).toMatchObject({
      spaceRegistry: { missing: ["SHUTTER_ENCRYPTION_KEY"] },
      jobApi: { missing: ["SHUTTER_ENCRYPTION_KEY"] },
      sourcePurge: { missing: ["SHUTTER_ENCRYPTION_KEY"] },
      edgeConfig: { missing: ["SHUTTER_ENCRYPTION_KEY"] },
      admin: { missing: ["SHUTTER_ENCRYPTION_KEY"] },
      masterStore: "ready",
    });
    await runtime.close();
  });

  it("names exactly the variable that would enable Source Purge", async () => {
    const runtime = build(without("CLOUDFLARE_ZONE_ID"));
    expect(runtime.features.sourcePurge).toEqual({ missing: ["CLOUDFLARE_ZONE_ID"] });
    expect(runtime.jobApiRuntime).toBeDefined();
    expect(runtime.jobApiRuntime?.sourcePurge).toBeUndefined();
    await runtime.close();
  });

  it("keeps the Job API but disables its dispatch for an unconfigured executor", async () => {
    const runtime = build(without("PDF_EXECUTOR_TOKEN"));
    expect(runtime.features.executorDispatch).toEqual({ missing: ["PDF_EXECUTOR_TOKEN"] });
    expect(runtime.jobApiRuntime?.executorToken("pdf")).toBeUndefined();
    expect(runtime.jobApiRuntime?.executorToken("video")).toBe(TOKEN);
    await expect(runtime.jobApiRuntime?.dispatch("pdf")).rejects.toThrow(
      "pdf executor dispatch is not configured",
    );
    await runtime.close();
  });

  it("authenticates an executor by its token even when Control cannot wake it", async () => {
    // Executors poll Control for work; a token without a wake URL must still
    // pass claim authentication, as it did before dispatch became a feature.
    const runtime = build(without("PDF_EXECUTOR_BASE_URL"));
    expect(runtime.features.executorDispatch).toEqual({ missing: ["PDF_EXECUTOR_BASE_URL"] });
    expect(runtime.jobApiRuntime?.executorToken("pdf")).toBe(TOKEN);
    await expect(runtime.jobApiRuntime?.dispatch("pdf")).rejects.toThrow(
      "pdf executor dispatch is not configured",
    );
    await runtime.close();
  });

  it("wakes a configured executor through the injected fetch", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const runtime = buildControlRuntime(createServerEnv(FULL_ENVIRONMENT), {
      logger: NOOP_LOGGER,
      fetch,
      now: () => new Date(),
    });
    await runtime.jobApiRuntime?.dispatch("video");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://video.internal:3000/internal/v1/run-once");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    await runtime.close();
  });

  it("fails the boot on a supplied but malformed value", () => {
    expect(() => build({ ...FULL_ENVIRONMENT, SHUTTER_ENCRYPTION_KEY: "not-hex" })).toThrow(
      /SHUTTER_ENCRYPTION_KEY is set but not usable/u,
    );
    expect(() =>
      build({ ...FULL_ENVIRONMENT, DATABASE_URL: "https://not-a-database.example" }),
    ).toThrow(/DATABASE_URL is set but not usable/u);
    // A bad value fails the boot even when its feature stays disabled anyway.
    expect(() => build({ SHUTTER_ENCRYPTION_KEY: "not-hex" })).toThrow(
      /SHUTTER_ENCRYPTION_KEY is set but not usable/u,
    );
  });

  it("closes a runtime whose pool never connected", async () => {
    await expect(build(FULL_ENVIRONMENT).close()).resolves.toBeUndefined();
    await expect(build({}).close()).resolves.toBeUndefined();
  });
});
