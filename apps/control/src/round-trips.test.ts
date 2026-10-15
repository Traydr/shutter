import { randomBytes } from "node:crypto";
import { issueSourceCapability, type JsonObject, type SpacePolicy } from "@shutter/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlApp } from "./app.js";
import { parseImgproxyConfig } from "./imgproxy.js";
import type { ControlLogger } from "./logging.js";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "./postgres-test.js";
import { createSourcePurge } from "./source-purge.js";
import { createSourceResolverService } from "./source-resolvers.js";
import { CapabilityKeyEncryption } from "./spaces/encryption.js";
import { PostgresSpaceRegistry } from "./spaces/postgres-registry.js";

const NOOP_LOGGER: ControlLogger = { emit() {}, async shutdown() {} };
const ORIGIN_TOKEN = "o".repeat(32);
const API_TOKEN = "test_api_token_abcdefghijklmnopqrstuvwxyz0123456789";
const VIDEO_TOKEN = "v".repeat(32);
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const NOW = new Date("2026-10-15T12:00:00.000Z");

const policy: SpacePolicy = {
  id: "example-public",
  routeClass: "public",
  qualities: [75],
  defaultQuality: 75,
  allowedSourceOrigins: [
    { origin: "https://sources.example.com" },
    { origin: "https://objects.example.test", pathPrefix: "/example-bucket" },
  ],
  resolvers: [
    {
      id: "files",
      type: "template",
      url: "https://sources.example.com/{file}",
      placeholders: { file: {} },
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

/**
 * Pins how many statements each Control route sends Postgres, through every
 * real adapter on one recorded pool. A registry read is one statement; the
 * rest is the job ledger's own transaction.
 */
describe("Postgres round trips per route", () => {
  let test: PostgresTestLifecycle;

  beforeAll(async () => {
    test = await createPostgresTestLifecycle();
  });

  afterAll(async () => test.close());

  it("sends one registry statement per request", async () => {
    const registry = new PostgresSpaceRegistry(test.pool, {
      encryption: new CapabilityKeyEncryption(randomBytes(32).toString("hex")),
      now: () => NOW,
    });
    await registry.createSpace(policy, [
      { resolverId: "media", accessKeyId: "AKIA", secretAccessKey: "secret" },
    ]);
    await registry.issueApiToken(policy.id, "application", API_TOKEN);
    await registry.addCapabilityKey(policy.id, "key-1", KEY);
    await registry.addCapabilityKey(policy.id, "key-2");
    const sourceResolvers = createSourceResolverService({
      credentials: registry,
      presigner: {
        presign: async ({ key }) => `https://objects.example.test/example-bucket/${key}`,
      },
    });
    const fetch = async (input: RequestInfo | URL) =>
      String(input).includes("api.cloudflare.com")
        ? Response.json({ success: true })
        : new Response("webp", { headers: { "content-type": "image/webp" } });
    const app = createControlApp({
      logger: NOOP_LOGGER,
      originAuthToken: () => ORIGIN_TOKEN,
      edgeConfigToken: () => ORIGIN_TOKEN,
      imgproxyConfig: () =>
        parseImgproxyConfig({
          baseUrl: "http://imgproxy.internal:8080",
          key: "736563726574",
          salt: "68656c6c6f",
          secret: "s".repeat(32),
        }),
      fetch,
      spaceRegistry: registry,
      sourceResolvers,
      jobApiRuntime: {
        logger: NOOP_LOGGER,
        lifecycle: test.lifecycle,
        now: () => NOW,
        spaceRegistry: registry,
        executorToken: () => VIDEO_TOKEN,
        jobDispatch: { dispatch: () => {}, scheduleDispatch: () => {} },
        sourceResolvers,
        sourcePurge: createSourcePurge({
          logger: NOOP_LOGGER,
          lifecycle: test.lifecycle,
          s3: { send: async () => ({ Contents: [], IsTruncated: false }) },
          bucket: "shutter-media",
          cloudflareZoneId: "zone",
          cloudflareApiToken: "token",
          edgeBaseUrl: "https://edge.example.test",
          edgeAuthToken: ORIGIN_TOKEN,
          fetch,
        }),
      },
    });

    const statements: Record<string, number> = {};
    const measure = async (route: string, request: () => Response | Promise<Response>) => {
      test.queries.reset();
      const response = await request();
      await response.arrayBuffer();
      expect(response.ok, route).toBe(true);
      // A token's usage write is sent after the response; let it land.
      await vi.waitFor(() => expect(test.pool.idleCount).toBe(test.pool.totalCount));
      statements[route] = test.queries.statements.length;
    };
    const internal = (path: string, body: JsonObject) =>
      app.request(`http://control.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${ORIGIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const optimize = (input: JsonObject) =>
      internal("/internal/v2/optimize", { spaceId: policy.id, input, width: 640, quality: 75 });
    const application = { authorization: `Bearer ${API_TOKEN}` };
    const v2Job =
      "http://control.test/v2/spaces/example-public/sources/media%2Fclip.mp4/previews/video";
    const v1Job = "http://control.test/v1/spaces/example-public/sources/source-1/previews/video";
    const seconds = Math.floor(NOW.getTime() / 1_000);
    const capability = await issueSourceCapability(
      {
        space_id: policy.id,
        source_id: "source-1",
        purpose: "preview_job",
        kind: "video",
        locator: "https://sources.example.com/source-1.mp4",
        iat: seconds - 60,
        exp: seconds + 3_600,
      },
      { kid: "key-1", key: KEY },
    );
    const claim = () =>
      app.request("http://control.test/internal/v1/executors/video/claim", {
        method: "POST",
        headers: { authorization: `Bearer ${VIDEO_TOKEN}` },
      });

    await measure("optimize, located", () =>
      optimize({ type: "located", sourceUrl: "https://sources.example.com/a.jpg" }),
    );
    await measure("optimize, template resolver", () =>
      optimize({ type: "resolved", resolverId: "files", reference: ["a.jpg"] }),
    );
    await measure("optimize, s3 resolver", () =>
      optimize({ type: "resolved", resolverId: "media", reference: ["a.jpg"] }),
    );
    await measure("resolve, s3 resolver", () =>
      internal("/internal/v2/resolve", {
        spaceId: policy.id,
        resolverId: "media",
        reference: ["a.jpg"],
      }),
    );
    await measure("snapshot, rebuilt", () =>
      app.request("http://control.test/internal/v1/edge/config", {
        headers: { authorization: `Bearer ${ORIGIN_TOKEN}` },
      }),
    );
    await measure("snapshot, memoized", () =>
      app.request("http://control.test/internal/v1/edge/config", {
        headers: { authorization: `Bearer ${ORIGIN_TOKEN}` },
      }),
    );
    await measure("v2 submit, first use of the token", () =>
      app.request(v2Job, {
        method: "PUT",
        headers: { ...application, "content-type": "application/json" },
        body: "{}",
      }),
    );
    await measure("v2 poll", () => app.request(v2Job, { headers: application }));
    await measure("v1 submit", () =>
      app.request(v1Job, {
        method: "PUT",
        headers: { ...application, "content-type": "application/json" },
        body: JSON.stringify({ sourceCapability: capability }),
      }),
    );
    await measure("v1 poll", () => app.request(v1Job, { headers: application }));
    await measure("claim, s3 resolver job", claim);
    await measure("claim, capability job", claim);
    await measure("v2 purge", () =>
      app.request("http://control.test/v2/spaces/example-public/sources/media%2Fclip.mp4/purge", {
        method: "POST",
        headers: application,
      }),
    );

    expect(statements).toEqual({
      // Before: 5 (begin, three policy selects, commit).
      "optimize, located": 1,
      "optimize, template resolver": 1,
      // Before: 11, two transactions: the policy, then the policy again and the credential.
      "optimize, s3 resolver": 1,
      "resolve, s3 resolver": 1,
      // Before: 7 on every poll. Now one generation read, plus one build when it moved.
      "snapshot, rebuilt": 2,
      "snapshot, memoized": 1,
      // The authorization, the throttled usage write, and the ledger's transaction.
      "v2 submit, first use of the token": 6,
      // Before: 9 (seven to authorize, a usage write, the job read).
      "v2 poll": 2,
      "v1 submit": 5,
      "v1 poll": 2,
      // The claim transaction (4), the Space read, and the resolver credential read.
      // Before: 16 and 10.
      "claim, s3 resolver job": 6,
      "claim, capability job": 5,
      // The authorization, then the purge's lock, job deletion, and unlock.
      "v2 purge": 6,
    });
  });
});
