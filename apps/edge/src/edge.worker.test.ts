import { env, reset, SELF } from "cloudflare:test";
import {
  buildCanonicalCacheUrl,
  buildMasterPreviewKey,
  buildMasterPurgePrefix,
  buildR2CacheKey,
  buildR2CachePurgePrefix,
  buildSourceCacheTag,
  sourceFingerprint,
  verifySourceCapability,
} from "@shutter/protocol";
import { issueSourceCapabilityWithIv } from "@shutter/protocol/testing";
import {
  CACHE_IDENTITY_EXPECTED,
  CACHE_IDENTITY_FIXTURE,
  runCapabilityConformance,
  TEST_CAPABILITY_KEY,
  TEST_CAPABILITY_KID,
} from "@shutter/testkit";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  await reset();
});

describe("edge app", () => {
  it("reports health from workerd", async () => {
    const response = await SELF.fetch("https://edge.shutter.test/healthz");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "edge" });
  });

  it("returns no bytes from unimplemented v1 routes", async () => {
    const response = await SELF.fetch(
      "https://edge.shutter.test/v1/private/pane-view/source/not-a-capability?w=640&q=75",
    );
    expect(response.status).toBe(404);
  });

  it("validates a private capability before returning R2 or edge-cache bytes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sourceId = "private-master-source";
    const token = await issueSourceCapabilityWithIv(
      {
        space_id: "pane-view",
        source_id: sourceId,
        purpose: "master_preview",
        kind: "video",
        iat: now - 60,
        exp: now + 3_600,
      },
      { kid: TEST_CAPABILITY_KID, key: TEST_CAPABILITY_KEY },
      Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    );
    const identity = {
      routeClass: "private" as const,
      spaceId: "pane-view",
      sourceId,
      input: { type: "master" as const, kind: "video" as const },
      width: 640,
      quality: 75,
    };
    await env.RENDITION_STORE.put(await buildR2CacheKey(identity), "private-rendition", {
      httpMetadata: { contentType: "image/webp" },
    });

    const tampered = await SELF.fetch(
      `https://edge.shutter.test/v1/private/pane-view/master/${token.slice(0, -1)}x?w=640&q=75`,
    );
    expect(tampered.status).toBe(403);
    expect(await tampered.text()).not.toContain("private-rendition");

    const first = await SELF.fetch(
      `https://edge.shutter.test/v1/private/pane-view/master/${token}?w=640&q=75`,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("x-shutter-cache")).toBe("r2-hit");
    expect(new TextDecoder().decode(await first.arrayBuffer())).toBe("private-rendition");

    const second = await SELF.fetch(
      `https://edge.shutter.test/v1/private/pane-view/master/${token}?w=640&q=75`,
    );
    expect(second.headers.get("x-shutter-cache")).toBe("edge-hit");
    expect(new TextDecoder().decode(await second.arrayBuffer())).toBe("private-rendition");
  });

  it("excludes a public located-source capability from canonical cached identity", async () => {
    const sourceId = "public-located-source";
    const identity = {
      routeClass: "public" as const,
      spaceId: "ernesta",
      sourceId,
      input: { type: "source" as const },
      width: 640,
      quality: 75,
    };
    await env.RENDITION_STORE.put(await buildR2CacheKey(identity), "public-rendition", {
      httpMetadata: { contentType: "image/webp" },
    });

    const response = await SELF.fetch(
      `https://edge.shutter.test/v1/public/ernesta/located/${sourceId}/not-a-capability?w=640&q=75`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-shutter-cache")).toBe("r2-hit");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400, s-maxage=2592000");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("public-rendition");
  });

  it("fails a public located-source miss closed before contacting the origin", async () => {
    const response = await SELF.fetch(
      "https://edge.shutter.test/v1/public/ernesta/located/missing/not-a-capability?w=640&q=75",
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("workerd protocol conformance", () => {
  it("matches the shared AES-GCM fixtures", async () => {
    await runCapabilityConformance({
      issueWithIv: issueSourceCapabilityWithIv,
      verify: verifySourceCapability,
    });
  });

  it("matches the shared cache identity fixtures", async () => {
    await expect(
      sourceFingerprint(CACHE_IDENTITY_FIXTURE.spaceId, CACHE_IDENTITY_FIXTURE.sourceId),
    ).resolves.toBe(CACHE_IDENTITY_EXPECTED.fingerprint);
    await expect(buildR2CacheKey(CACHE_IDENTITY_FIXTURE)).resolves.toBe(
      CACHE_IDENTITY_EXPECTED.r2Key,
    );
    await expect(
      buildMasterPreviewKey(
        CACHE_IDENTITY_FIXTURE.spaceId,
        CACHE_IDENTITY_FIXTURE.sourceId,
        "video",
      ),
    ).resolves.toBe(CACHE_IDENTITY_EXPECTED.masterKey);
    await expect(
      buildR2CachePurgePrefix(
        CACHE_IDENTITY_FIXTURE.routeClass,
        CACHE_IDENTITY_FIXTURE.spaceId,
        CACHE_IDENTITY_FIXTURE.sourceId,
      ),
    ).resolves.toBe(CACHE_IDENTITY_EXPECTED.cachePrefix);
    await expect(
      buildMasterPurgePrefix(CACHE_IDENTITY_FIXTURE.spaceId, CACHE_IDENTITY_FIXTURE.sourceId),
    ).resolves.toBe(CACHE_IDENTITY_EXPECTED.masterPrefix);
    await expect(
      buildSourceCacheTag(CACHE_IDENTITY_FIXTURE.spaceId, CACHE_IDENTITY_FIXTURE.sourceId),
    ).resolves.toBe(CACHE_IDENTITY_EXPECTED.cacheTag);
    await expect(buildCanonicalCacheUrl(CACHE_IDENTITY_FIXTURE)).resolves.toBe(
      CACHE_IDENTITY_EXPECTED.canonicalUrl,
    );
  });
});
