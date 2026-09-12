import { AdminApiError, createAdminApiClient } from "@shutter/admin-api";
import type { SpacePolicy } from "@shutter/protocol";
import { describe, expect, it, vi } from "vitest";
import { type AdminApiRuntime, createAdminApi } from "./admin-api.js";
import { EdgeRefreshTracker } from "./edge-refresh-status.js";
import { createSourceResolverService } from "./source-resolvers.js";
import { MemorySpaceRegistry } from "./spaces/memory-registry.js";

const TOKEN = "admin_api_token_abcdefghijklmnopqrstuvwxyz0123";
const ORIGIN = "https://control.example.test";

const PUBLIC_SPACE: SpacePolicy = {
  id: "example-public",
  routeClass: "public",
  qualities: [60, 75],
  defaultQuality: 75,
  allowedSourceOrigins: [
    { origin: "https://uploads.example.test" },
    { origin: "https://objects.example.test", pathPrefix: "/example-bucket" },
  ],
  resolvers: [],
};

class ReadFailsAfterIssueRegistry extends MemorySpaceRegistry {
  #issued = false;

  override async issueApiToken(spaceId: string, label: string, token?: string) {
    const issued = await super.issueApiToken(spaceId, label, token);
    this.#issued = true;
    return issued;
  }

  override async addCapabilityKey(spaceId: string, keyId: string, key?: Uint8Array) {
    const issued = await super.addCapabilityKey(spaceId, keyId, key);
    this.#issued = true;
    return issued;
  }

  #readable(): void {
    if (this.#issued) throw new Error("read unavailable after commit");
  }

  override async getSpace(spaceId: string) {
    this.#readable();
    return super.getSpace(spaceId);
  }

  override async getGeneration() {
    this.#readable();
    return super.getGeneration();
  }

  override async listApiTokens(spaceId: string) {
    this.#readable();
    return super.listApiTokens(spaceId);
  }

  override async listCapabilityKeys(spaceId: string) {
    this.#readable();
    return super.listCapabilityKeys(spaceId);
  }
}

function runtime(
  registry: MemorySpaceRegistry | undefined = new MemorySpaceRegistry({ spaces: [PUBLIC_SPACE] }),
  extra: Partial<AdminApiRuntime> = {},
): AdminApiRuntime {
  return {
    token: () => TOKEN,
    registry,
    imgproxyAllowedSources: () => "https://uploads.example.test/",
    edgeRefreshStatus: () => undefined,
    edgeBaseUrl: () => "https://edge.example.test",
    ...extra,
  };
}

function client(app: ReturnType<typeof createAdminApi>, token = TOKEN) {
  return createAdminApiClient({
    baseUrl: ORIGIN,
    token,
    fetch: (input, init) => app.request(input, init),
  });
}

async function failure(work: Promise<object>): Promise<AdminApiError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AdminApiError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("admin API", () => {
  it("refuses every route without the token, and reports an absent registry", async () => {
    const app = createAdminApi(runtime());
    const anonymous = await app.request(`${ORIGIN}/v1/admin/overview`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    expect(anonymous.headers.get("content-type")).toBe("application/problem+json");
    await expect(anonymous.json()).resolves.toMatchObject({ code: "unauthorized" });

    const wrong = await failure(client(app, "x".repeat(40)).overview());
    expect(wrong.status).toBe(401);
    expect(wrong.code).toBe("unauthorized");

    const unset = createAdminApi(runtime(undefined, { token: () => undefined }));
    expect((await unset.request(`${ORIGIN}/v1/admin/overview`)).status).toBe(401);

    const noRegistry = await failure(
      client(createAdminApi({ ...runtime(), registry: undefined })).overview(),
    );
    expect(noRegistry.status).toBe(503);
    expect(noRegistry.code).toBe("service_unavailable");
  });

  it("answers an unknown admin path with a problem, not a page", async () => {
    const response = await createAdminApi(runtime()).request(`${ORIGIN}/v1/admin/nothing`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("reports the registry state and deployment coverage on the overview", async () => {
    const refresh = new EdgeRefreshTracker(() => new Date("2026-09-12T10:00:00.000Z"));
    refresh.report(0);
    const app = createAdminApi(runtime(undefined, { edgeRefreshStatus: () => refresh.latest() }));
    const overview = await client(app).overview();
    expect(overview.generation).toBe(0);
    expect(overview.spaces.map((space) => space.policy.id)).toEqual(["example-public"]);
    expect(overview.spaces[0]?.status).toBe("active");
    expect(overview.coverage).toEqual({
      derivedValue: "https://objects.example.test/example-bucket,https://uploads.example.test",
      uncovered: ["https://objects.example.test/example-bucket"],
    });
    expect(overview.edgeRefresh).toEqual({
      generation: 0,
      refreshedAt: "2026-09-12T10:00:00.000Z",
    });
    expect(overview.edgeBaseUrl).toBe("https://edge.example.test");
  });

  it("walks a Space through its life over the client", async () => {
    const registry = new MemorySpaceRegistry();
    const app = createAdminApi(runtime(registry));
    const api = client(app);

    const created = await api.createSpace({
      id: "ernesta",
      routeClass: "private",
      qualities: [60, 80],
      defaultQuality: 80,
      allowedSourceOrigins: [{ origin: "https://uploads.example.test", pathPrefix: "/f/" }],
    });
    expect(created.generation).toBe(1);
    expect(created.space.policy).toMatchObject({
      id: "ernesta",
      routeClass: "private",
      resolvers: [],
      allowedSourceOrigins: [{ origin: "https://uploads.example.test", pathPrefix: "/f" }],
    });

    const policy = await api.updateSpacePolicy("ernesta", {
      qualities: [60, 80, 90],
      defaultQuality: 90,
      allowedSourceOrigins: [{ origin: "https://uploads.example.test" }],
    });
    expect(policy.generation).toBe(2);
    expect(policy.space.policy.defaultQuality).toBe(90);

    const resolver = await api.createResolver("ernesta", {
      resolver: {
        id: "media",
        type: "template",
        url: "https://uploads.example.test/f/{file}",
        placeholders: { file: {} },
      },
    });
    expect(resolver.generation).toBe(3);
    expect(resolver.space.policy.resolvers).toHaveLength(1);

    // A policy save carries the stored resolver list through untouched.
    const kept = await api.updateSpacePolicy("ernesta", {
      qualities: [60, 80, 90],
      defaultQuality: 80,
      allowedSourceOrigins: [{ origin: "https://uploads.example.test" }],
    });
    expect(kept.space.policy.resolvers.map((entry) => entry.id)).toEqual(["media"]);

    const replaced = await api.replaceResolver("ernesta", "media", {
      resolver: {
        id: "media",
        type: "template",
        url: "https://uploads.example.test/f/{file}/{size}",
        placeholders: { file: {}, size: { allowed: ["small", "large"] } },
      },
    });
    expect(replaced.space.policy.resolvers[0]).toMatchObject({
      url: "https://uploads.example.test/f/{file}/{size}",
    });

    const issued = await api.issueApiToken("ernesta", { label: "production" });
    expect(issued.secret.length).toBeGreaterThanOrEqual(32);
    expect(issued.apiToken).toMatchObject({ id: 1, label: "production" });
    expect(issued.apiToken.displayPrefix).toBe(
      issued.secret.slice(0, issued.apiToken.displayPrefix.length),
    );

    const key = await api.addCapabilityKey("ernesta", { keyId: "k-2026-09" });
    expect(key.secret.length).toBeGreaterThan(0);
    expect(key.capabilityKey).toMatchObject({ id: 1, keyId: "k-2026-09" });

    const detail = await api.space("ernesta");
    expect(detail.generation).toBe(replaced.generation + 2);
    expect(detail.apiTokens).toEqual([issued.apiToken]);
    expect(detail.capabilityKeys).toEqual([key.capabilityKey]);
    expect(detail.resolverCredentials).toEqual([]);
    expect(detail.coverage.uncovered).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain(issued.secret);
    expect(JSON.stringify(detail)).not.toContain(key.secret);

    const revoked = await api.revokeApiToken("ernesta", issued.apiToken.id);
    expect(revoked.apiToken.revokedAt).toBeDefined();
    const disabled = await api.disableCapabilityKey("ernesta", "k-2026-09");
    expect(disabled.capabilityKey.disabledAt).toBeDefined();

    const removed = await api.removeResolver("ernesta", "media");
    expect(removed.space.policy.resolvers).toEqual([]);

    const decommissioned = await api.decommissionSpace("ernesta");
    expect(decommissioned.space.status).toBe("decommissioned");
    expect(decommissioned.space.decommissionedAt).toBeDefined();
    expect((await api.overview()).generation).toBe(decommissioned.generation);
  });

  it("names the rejected input in the problem detail", async () => {
    const app = createAdminApi(runtime());
    const api = client(app);

    const badPolicy = await failure(
      api.createSpace({
        id: "second",
        routeClass: "public",
        qualities: [60],
        defaultQuality: 75,
        allowedSourceOrigins: [{ origin: "https://uploads.example.test" }],
      }),
    );
    expect(badPolicy.status).toBe(400);
    expect(badPolicy.code).toBe("request_invalid");
    expect(badPolicy.detail).toBe("defaultQuality must be one of the permitted qualities");

    const taken = await failure(
      api.createSpace({
        id: "example-public",
        routeClass: "public",
        qualities: [75],
        defaultQuality: 75,
        allowedSourceOrigins: [{ origin: "https://uploads.example.test" }],
      }),
    );
    expect(taken.status).toBe(409);
    expect(taken.code).toBe("conflict");

    const missing = await failure(api.space("nobody"));
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("not_found");

    const renamed = await failure(
      api.replaceResolver("example-public", "media", {
        resolver: {
          id: "other",
          type: "template",
          url: "https://uploads.example.test/{file}",
          placeholders: { file: {} },
        },
      }),
    );
    expect(renamed.status).toBe(404);

    const outside = await failure(
      api.createResolver("example-public", {
        resolver: {
          id: "elsewhere",
          type: "template",
          url: "https://elsewhere.example.test/{file}",
          placeholders: { file: {} },
        },
      }),
    );
    expect(outside.status).toBe(400);
    expect(outside.detail).toContain("outside allowedSourceOrigins");

    const badId = await failure(api.revokeApiToken("example-public", 0));
    expect(badId.status).toBe(400);
    expect(badId.detail).toBe("the token identifier must be a positive integer");

    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const notJson = await app.request(`${ORIGIN}/v1/admin/spaces`, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(notJson.status).toBe(400);
    await expect(notJson.json()).resolves.toMatchObject({
      code: "request_invalid",
      detail: "the request body is not valid JSON",
    });

    const form = await app.request(`${ORIGIN}/v1/admin/spaces`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: "id=x",
    });
    expect(form.status).toBe(400);

    // An unknown key is submitted text; the detail names the location, never the key.
    const unknownField = await app.request(`${ORIGIN}/v1/admin/spaces/example-public/api-tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "x", "https://leak.example/?token=secret": "everything" }),
    });
    expect(unknownField.status).toBe(400);
    const unknownFieldBody = await unknownField.text();
    expect(unknownFieldBody).toContain('"detail":"the document has an unknown field"');
    expect(unknownFieldBody).not.toContain("leak.example");

    const wrongType = await app.request(`${ORIGIN}/v1/admin/spaces/example-public/api-tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: 7 }),
    });
    await expect(wrongType.json()).resolves.toMatchObject({
      detail: "label: Invalid input: expected string, received number",
    });

    const huge = await app.request(`${ORIGIN}/v1/admin/spaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "x".repeat(40_000) }),
    });
    expect(huge.status).toBe(413);
    await expect(huge.json()).resolves.toMatchObject({ code: "payload_too_large" });
  });

  it("reports a response it does not understand as a transport error", async () => {
    const api = createAdminApiClient({
      baseUrl: ORIGIN,
      token: TOKEN,
      fetch: async () => Response.json({ generation: "one" }),
    });
    const error = await failure(api.overview());
    expect(error.code).toBe("transport");
    expect(error.status).toBe(200);
    expect(error.message).toContain("does not understand");
  });

  it("answers an issued secret from the mutation alone", async () => {
    const registry = new ReadFailsAfterIssueRegistry({ spaces: [PUBLIC_SPACE] });
    const api = client(createAdminApi(runtime(registry)));

    const issued = await api.issueApiToken("example-public", { label: "deploy" });
    expect(issued.generation).toBe(1);
    expect(issued.secret.length).toBeGreaterThanOrEqual(32);

    const key = await api.addCapabilityKey("example-public", { keyId: "k1" });
    expect(key.generation).toBe(2);
    expect(key.secret.length).toBeGreaterThan(0);
  });

  it("tests a resolver by host only, never by signed location", async () => {
    const registry = new MemorySpaceRegistry({ spaces: [PUBLIC_SPACE] });
    const probeLocation = vi.fn(async () => ({
      status: 206,
      headers: new Headers({
        "content-type": "image/jpeg",
        "content-range": "bytes 0-0/12345",
      }),
    }));
    const app = createAdminApi(
      runtime(registry, {
        sourceResolvers: createSourceResolverService({
          credentials: registry,
          presigner: {
            presign: async ({ key }) =>
              `https://objects.example.test/example-bucket/${key}?X-Amz-Signature=sealed`,
          },
        }),
        probeLocation,
        addressLookup: async () => ["93.184.216.34"],
      }),
    );
    const api = client(app);

    const created = await api.createResolver("example-public", {
      resolver: {
        id: "originals",
        type: "s3",
        endpoint: "https://objects.example.test",
        region: "auto",
        bucket: "example-bucket",
        pathStyle: true,
        keyTemplate: "{key}",
      },
      credential: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret-value" },
    });
    expect(created.space.policy.resolvers[0]?.type).toBe("s3");

    const detail = await api.space("example-public");
    expect(detail.resolverCredentials).toMatchObject([
      { resolverId: "originals", accessKeyId: "AKIAEXAMPLE" },
    ]);
    expect(JSON.stringify(detail)).not.toContain("secret-value");

    const result = await api.testResolver("example-public", "originals", {
      reference: ["photo.jpg"],
    });
    expect(result).toEqual({
      outcome: "ok",
      message: "The location answered with bytes.",
      sourceId: "originals/photo.jpg",
      host: "objects.example.test",
      status: 206,
      contentType: "image/jpeg",
      contentLength: 12345,
    });
    expect(JSON.stringify(result)).not.toContain("X-Amz");
    expect(probeLocation).toHaveBeenCalledWith(
      expect.stringContaining("X-Amz-Signature=sealed"),
      "93.184.216.34",
      5_000,
    );

    const unknown = await failure(
      api.testResolver("example-public", "nothing", { reference: ["photo.jpg"] }),
    );
    expect(unknown.status).toBe(404);
  });
});
