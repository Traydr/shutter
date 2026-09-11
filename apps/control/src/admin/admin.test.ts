import { describe, expect, it, vi } from "vitest";
import { EdgeRefreshTracker } from "../edge-refresh-status.js";
import { createSourceResolverService } from "../source-resolvers.js";
import { MemorySpaceRegistry } from "../spaces/memory-registry.js";
import { type AdminRuntime, createAdminApp } from "./app.js";
import { deploymentCoverage } from "./deployment-coverage.js";

const BOOTSTRAP_TOKEN = "admin_bootstrap_token_abcdefghijklmnopqrstuvwxyz";
const ORIGIN = "https://control.example.test";

class ReadFailsAfterIssueRegistry extends MemorySpaceRegistry {
  #issued = false;

  override async issueApiToken(spaceId: string, label: string, token?: string) {
    const issued = await super.issueApiToken(spaceId, label, token);
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

  override async listSpaces() {
    this.#readable();
    return super.listSpaces();
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
  registry = new MemorySpaceRegistry(),
  options: { now?: () => number; allowedSources?: string; refresh?: EdgeRefreshTracker } = {},
): AdminRuntime {
  const admin: AdminRuntime = {
    bootstrapToken: () => BOOTSTRAP_TOKEN,
    imgproxyAllowedSources: () => options.allowedSources,
    edgeRefreshStatus: () => options.refresh?.latest(),
    registry,
  };
  if (options.now !== undefined) admin.now = options.now;
  return admin;
}

async function login(app: ReturnType<typeof createAdminApp>): Promise<{
  cookie: string;
  csrf: string;
}> {
  const response = await app.request(`${ORIGIN}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: BOOTSTRAP_TOKEN }),
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(response.headers.get("set-cookie")).toContain("Secure");
  expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const dashboard = await app.request(`${ORIGIN}/`, { headers: { cookie } });
  const body = await dashboard.text();
  const csrf = /name="csrf" value="([^"]+)"/u.exec(body)?.[1];
  expect(csrf).toMatch(/^[A-Za-z0-9_-]{32}$/u);
  return { cookie, csrf: csrf ?? "" };
}

function formRequest(
  app: ReturnType<typeof createAdminApp>,
  path: string,
  cookie: string,
  values: Record<string, string>,
  origin = ORIGIN,
): Promise<Response> {
  return app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
  });
}

describe("Control admin surface", () => {
  it("keeps the referrer policy compatible with the same-host Origin check", async () => {
    // Under no-referrer, browsers send `Origin: null` on same-origin form
    // POSTs (Fetch spec), which the CSRF middleware must reject — so the
    // pages must never regress to that policy.
    const app = createAdminApp(runtime());
    const login = await app.request(`${ORIGIN}/`);
    expect(login.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("keeps every management route behind a short-lived secure session", async () => {
    let now = Date.parse("2026-08-11T12:00:00.000Z");
    const app = createAdminApp(runtime(new MemorySpaceRegistry(), { now: () => now }));

    expect((await app.request(`${ORIGIN}/spaces/example`)).status).toBe(303);
    expect(
      (
        await app.request(`${ORIGIN}/login`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: "wrong".repeat(8) }),
        })
      ).status,
    ).toBe(401);

    const { cookie } = await login(app);
    expect((await app.request(`${ORIGIN}/`, { headers: { cookie } })).status).toBe(200);
    const tamperedCookie = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    expect(
      (await app.request(`${ORIGIN}/spaces/example`, { headers: { cookie: tamperedCookie } }))
        .status,
    ).toBe(303);
    now += 15 * 60_000;
    const expired = await app.request(`${ORIGIN}/`, { headers: { cookie } });
    expect(await expired.text()).toContain("Bootstrap token");
    expect((await app.request(`${ORIGIN}/spaces/example`, { headers: { cookie } })).status).toBe(
      303,
    );
  });

  it("returns unavailable when the registry or bootstrap token is not configured", async () => {
    const withoutRegistry = createAdminApp({
      bootstrapToken: () => BOOTSTRAP_TOKEN,
      imgproxyAllowedSources: () => undefined,
      edgeRefreshStatus: () => undefined,
    });
    const withoutToken = createAdminApp({
      bootstrapToken: () => undefined,
      imgproxyAllowedSources: () => undefined,
      edgeRefreshStatus: () => undefined,
      registry: new MemorySpaceRegistry(),
    });
    expect((await withoutRegistry.request(`${ORIGIN}/`)).status).toBe(503);
    expect((await withoutToken.request(`${ORIGIN}/`)).status).toBe(503);
  });

  it("requires a same-origin CSRF token for every state change", async () => {
    const registry = new MemorySpaceRegistry();
    const app = createAdminApp(runtime(registry));
    const { cookie, csrf } = await login(app);
    const values = {
      csrf,
      spaceId: "example-private",
      routeClass: "private",
      qualities: "50,75",
      defaultQuality: "75",
      allowedSourceOrigins: "https://sources.example.com/private",
    };

    expect(
      (await formRequest(app, "/spaces", cookie, values, "https://attacker.test")).status,
    ).toBe(403);
    expect(
      (await formRequest(app, "/spaces", cookie, { ...values, csrf: "x".repeat(32) })).status,
    ).toBe(403);
    await expect(registry.listSpaces()).resolves.toEqual([]);

    const throughProxy = await app.request("http://control.example.test/spaces", {
      method: "POST",
      headers: {
        cookie,
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(values),
    });
    expect(throughProxy.status).toBe(303);
  });

  it("rejects an oversized unauthenticated login body", async () => {
    const app = createAdminApp(runtime());
    const response = await app.request(`${ORIGIN}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "x".repeat(33 * 1_024) }),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("creates and edits a Space without exposing immutable edit controls", async () => {
    const registry = new MemorySpaceRegistry();
    const app = createAdminApp(runtime(registry));
    const { cookie, csrf } = await login(app);
    const created = await formRequest(app, "/spaces", cookie, {
      csrf,
      spaceId: "example-public",
      routeClass: "public",
      qualities: "50,75",
      defaultQuality: "75",
      allowedSourceOrigins: "https://sources.example.com/media",
    });

    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/admin/spaces/example-public?generation=1");
    const detail = await app.request(`${ORIGIN}/spaces/example-public`, { headers: { cookie } });
    const detailBody = await detail.text();
    expect(detailBody).toMatch(/Registry generation<\/dt><dd[^>]*>1</u);
    expect(detailBody).not.toContain('name="spaceId"');
    expect(detailBody).not.toContain('name="routeClass"');
    expect(detailBody).not.toContain('name="resolvers"');

    const edited = await formRequest(app, "/spaces/example-public/policy", cookie, {
      csrf,
      qualities: "60,80",
      defaultQuality: "80",
      allowedSourceOrigins: "https://new.example.com/assets",
    });
    expect(edited.headers.get("location")).toContain("generation=2");
    await expect(registry.getActiveSpacePolicy("example-public")).resolves.toMatchObject({
      id: "example-public",
      routeClass: "public",
      qualities: [60, 80],
    });

    const invalid = await formRequest(app, "/spaces/example-public/policy", cookie, {
      csrf,
      qualities: "80,80",
      defaultQuality: "80",
      allowedSourceOrigins: "https://new.example.com/assets",
    });
    expect(invalid.status).toBe(400);
  });

  it("adds, edits, tests, and removes resolvers through their own editor", async () => {
    const registry = new MemorySpaceRegistry({
      spaces: [
        {
          id: "example-public",
          routeClass: "public",
          qualities: [75],
          defaultQuality: 75,
          allowedSourceOrigins: [
            { origin: "https://example-project.ufs.sh", pathPrefix: "/f" },
            { origin: "https://objects.example.test", pathPrefix: "/example-bucket" },
          ],
          resolvers: [],
        },
      ],
    });
    const probed: string[] = [];
    const probeLocation = vi.fn(async (locator: string, address: string) => {
      probed.push(`${locator} via ${address}`);
      return {
        status: 206,
        headers: new Headers({
          "content-type":
            'image/jpeg; source="https://objects.example.test/leak?X-Amz-Signature=x"',
          "content-range": "bytes 0-0/12345",
        }),
      };
    });
    const resolvers = createSourceResolverService({
      credentials: registry,
      presigner: {
        presign: async ({ key }) =>
          `https://objects.example.test/example-bucket/${key}?X-Amz-Signature=sealed`,
      },
    });
    const app = createAdminApp({
      ...runtime(registry),
      sourceResolvers: resolvers,
      probeLocation,
      addressLookup: async () => ["93.184.216.34"],
      edgeBaseUrl: () => "https://edge.example.test",
    });
    const { cookie, csrf } = await login(app);

    // The new-resolver page carries the preset into the form.
    const preset = await app.request(
      `${ORIGIN}/spaces/example-public/resolvers/new?kind=template&preset=uploadthing`,
      { headers: { cookie } },
    );
    expect(preset.status).toBe(200);
    expect(await preset.text()).toContain('value="https://{project}.ufs.sh/f/{file}"');

    // A hostname placeholder without allowed values is refused by name.
    const unrestricted = await formRequest(app, "/spaces/example-public/resolvers", cookie, {
      csrf,
      resolverId: "ut",
      kind: "template",
      url: "https://{project}.ufs.sh/f/{file}",
      allowed: "",
    });
    expect(unrestricted.status).toBe(400);
    expect(await unrestricted.text()).toContain(
      "hostname placeholder must list its allowed values",
    );

    const createdTemplate = await formRequest(app, "/spaces/example-public/resolvers", cookie, {
      csrf,
      resolverId: "ut",
      kind: "template",
      url: "https://{project}.ufs.sh/f/{file}",
      allowed: "project=example-project",
    });
    expect(createdTemplate.status).toBe(303);
    expect(createdTemplate.headers.get("location")).toBe(
      "/admin/spaces/example-public/resolvers/ut?generation=1",
    );

    // An S3 resolver needs its credential; the secret is never shown again.
    const missingCredential = await formRequest(app, "/spaces/example-public/resolvers", cookie, {
      csrf,
      resolverId: "media",
      kind: "s3",
      endpoint: "https://objects.example.test",
      bucket: "example-bucket",
      keyTemplate: "originals/{key}",
      pathStyle: "on",
    });
    expect(missingCredential.status).toBe(400);
    expect(await missingCredential.text()).toContain("resolver media needs an S3 credential");
    const createdS3 = await formRequest(app, "/spaces/example-public/resolvers", cookie, {
      csrf,
      resolverId: "media",
      kind: "s3",
      endpoint: "https://objects.example.test",
      bucket: "example-bucket",
      keyTemplate: "originals/{key}",
      pathStyle: "on",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "top-secret-value",
    });
    expect(createdS3.status).toBe(303);
    const editor = await app.request(`${ORIGIN}/spaces/example-public/resolvers/media`, {
      headers: { cookie },
    });
    const editorBody = await editor.text();
    expect(editorBody).toContain("AKIAEXAMPLE");
    expect(editorBody).not.toContain("top-secret-value");
    expect(editorBody).toContain("https://edge.example.test/v2/example-public/media/{key}");
    const detail = await app.request(`${ORIGIN}/spaces/example-public`, { headers: { cookie } });
    const detailBody = await detail.text();
    expect(detailBody).toContain("https://{project}.ufs.sh/f/{file}");
    expect(detailBody).not.toContain("top-secret-value");
    await expect(registry.getActiveSpacePolicy("example-public")).resolves.toMatchObject({
      resolvers: [
        { id: "ut", type: "template" },
        { id: "media", type: "s3", pathStyle: true },
      ],
    });

    // A policy save carries the resolvers through untouched.
    await formRequest(app, "/spaces/example-public/policy", cookie, {
      csrf,
      qualities: "50,75",
      defaultQuality: "75",
      allowedSourceOrigins:
        "https://example-project.ufs.sh/f\nhttps://objects.example.test/example-bucket",
    });
    await expect(registry.getActiveSpacePolicy("example-public")).resolves.toMatchObject({
      qualities: [50, 75],
      resolvers: [{ id: "ut" }, { id: "media" }],
    });

    // Editing the S3 resolver without credential fields keeps the stored pair.
    const editedS3 = await formRequest(app, "/spaces/example-public/resolvers/media", cookie, {
      csrf,
      kind: "s3",
      endpoint: "https://objects.example.test",
      bucket: "example-bucket",
      keyTemplate: "{key}",
      pathStyle: "on",
    });
    expect(editedS3.status).toBe(303);
    await expect(registry.getResolverCredential("example-public", "media")).resolves.toEqual({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "top-secret-value",
    });

    // Test resolves and fetches one byte, reporting the host but never the signed URL.
    const tested = await formRequest(app, "/spaces/example-public/resolvers/media/test", cookie, {
      csrf,
      reference: "file.one",
    });
    expect(tested.status).toBe(200);
    const testedBody = await tested.text();
    expect(testedBody).toContain("The location answered with bytes.");
    expect(testedBody).toContain("media/file.one");
    expect(testedBody).toContain("objects.example.test");
    expect(testedBody).toContain("12345");
    expect(testedBody).not.toContain("X-Amz-Signature");
    expect(probed).toEqual([
      "https://objects.example.test/example-bucket/file.one?X-Amz-Signature=sealed via 93.184.216.34",
    ]);
    const badReference = await formRequest(
      app,
      "/spaces/example-public/resolvers/ut/test",
      cookie,
      { csrf, reference: "other/file" },
    );
    expect(await badReference.text()).toContain("does not fit this resolver");

    // Removal needs the identifier typed back and drops the credential with the row.
    const unconfirmed = await formRequest(
      app,
      "/spaces/example-public/resolvers/media/remove",
      cookie,
      { csrf, confirm: "nope" },
    );
    expect(unconfirmed.status).toBe(400);
    const removed = await formRequest(
      app,
      "/spaces/example-public/resolvers/media/remove",
      cookie,
      {
        csrf,
        confirm: "media",
      },
    );
    expect(removed.status).toBe(303);
    await expect(registry.listResolverCredentials("example-public")).resolves.toEqual([]);
    expect(
      (
        await app.request(`${ORIGIN}/spaces/example-public/resolvers/media`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(404);
  });

  it("shows generated credentials once and retains only credential summaries", async () => {
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
    const app = createAdminApp(runtime(registry));
    const { cookie, csrf } = await login(app);
    const issuedToken = await formRequest(app, "/spaces/example-private/api-tokens", cookie, {
      csrf,
      label: "<img src=x onerror=alert(1)>",
    });
    const tokenBody = await issuedToken.text();
    expect(tokenBody).toContain("shutter_api_");
    const fullToken = /<div class="secret">(shutter_api_[A-Za-z0-9_-]+)<\/div>/u.exec(
      tokenBody,
    )?.[1];
    expect(fullToken).toBeTypeOf("string");
    expect(tokenBody).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(tokenBody).not.toContain("<img src=x");

    const issuedKey = await formRequest(app, "/spaces/example-private/capability-keys", cookie, {
      csrf,
      keyId: "rotation-2026",
    });
    const keyBody = await issuedKey.text();
    expect(keyBody).toContain("New Capability Key");
    expect(keyBody).toMatch(/[A-Za-z0-9_-]{43}/u);

    expect(
      (await formRequest(app, "/spaces/example-private/api-tokens/1/revoke", cookie, { csrf }))
        .status,
    ).toBe(303);
    expect(
      (
        await formRequest(
          app,
          "/spaces/example-private/capability-keys/rotation-2026/disable",
          cookie,
          { csrf },
        )
      ).status,
    ).toBe(303);
    await expect(registry.listApiTokens("example-private")).resolves.toMatchObject([
      { id: 1, revokedAt: expect.any(Date) },
    ]);
    await expect(registry.listCapabilityKeys("example-private")).resolves.toMatchObject([
      { keyId: "rotation-2026", disabledAt: expect.any(Date) },
    ]);

    const revisited = await app.request(`${ORIGIN}/spaces/example-private`, {
      headers: { cookie },
    });
    const revisitedBody = await revisited.text();
    expect(revisitedBody).not.toContain(fullToken);
    expect(revisitedBody).not.toContain("This secret is shown once");
  });

  it("returns a one-time secret without a post-commit registry read", async () => {
    const registry = new ReadFailsAfterIssueRegistry({
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
    const app = createAdminApp(runtime(registry));
    const { cookie, csrf } = await login(app);
    const issued = await formRequest(app, "/spaces/example-private/api-tokens", cookie, {
      csrf,
      label: "application",
    });
    expect(issued.status).toBe(200);
    expect(await issued.text()).toContain("shutter_api_");
  });

  it("decommissions without deleting identity and blocks later writes", async () => {
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
    const app = createAdminApp(runtime(registry));
    const { cookie, csrf } = await login(app);
    const response = await formRequest(app, "/spaces/example-private/decommission", cookie, {
      csrf,
      confirm: "example-private",
    });
    expect(response.headers.get("location")).toBe("/admin?generation=1");
    await expect(registry.listSpaces()).resolves.toMatchObject([
      { status: "decommissioned", policy: { id: "example-private" } },
    ]);
    expect(
      (
        await formRequest(app, "/spaces/example-private/api-tokens", cookie, {
          csrf,
          label: "application",
        })
      ).status,
    ).toBe(404);
  });

  it("shows registry, Edge refresh, and deployment coverage status", async () => {
    const registry = new MemorySpaceRegistry({
      spaces: [
        {
          id: "example-public",
          routeClass: "public",
          qualities: [75],
          defaultQuality: 75,
          allowedSourceOrigins: [
            { origin: "https://covered.example.com", pathPrefix: "/media" },
            { origin: "https://missing.example.com" },
          ],
          resolvers: [],
        },
      ],
    });
    const refresh = new EdgeRefreshTracker(() => new Date("2026-08-11T12:00:00.000Z"));
    refresh.report(7);
    const app = createAdminApp(
      runtime(registry, {
        allowedSources: "https://covered.example.com",
        refresh,
      }),
    );
    const { cookie } = await login(app);
    const response = await app.request(`${ORIGIN}/`, { headers: { cookie } });
    const body = await response.text();

    expect(body).toContain("Latest Edge refresh");
    expect(body).toContain("2026-08-11T12:00:00.000Z");
    expect(body).toContain("https://covered.example.com/media,https://missing.example.com");
    expect(body).toContain("https://missing.example.com");
    expect(body).not.toContain("<li><code>https://covered.example.com/media</code></li>");
  });
});

describe("imgproxy deployment coverage", () => {
  it("treats an origin-level deployment prefix as covering narrower Space paths", () => {
    const spaces = [
      {
        policy: {
          id: "example-public",
          routeClass: "public",
          qualities: [75],
          defaultQuality: 75,
          allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/media" }],
          resolvers: [],
        },
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as const;
    expect(deploymentCoverage(spaces, "https://sources.example.com")).toEqual({
      derivedValue: "https://sources.example.com/media",
      uncovered: [],
    });
  });
});
