import {
  buildCanonicalCacheUrl,
  buildMasterPreviewKey,
  buildMasterPurgePrefix,
  buildPreviewJobUrl,
  buildPrivateMasterUrl,
  buildPrivateSourceUrl,
  buildPublicLocatedSourceUrl,
  buildPublicMasterUrl,
  buildPublicResolverUrl,
  buildR2CacheKey,
  buildR2CachePurgePrefix,
  buildSourceCacheTag,
  buildSourcePurgeUrl,
  sourceFingerprint,
  verifySourceCapability,
} from "@shutter/protocol";
import { issueSourceCapabilityWithIv } from "@shutter/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  CACHE_IDENTITY_EXPECTED,
  CACHE_IDENTITY_FIXTURE,
  runCapabilityConformance,
  URL_FIXTURES,
} from "./index.js";

describe("Node protocol conformance", () => {
  it("matches the shared AES-GCM fixtures", async () => {
    await runCapabilityConformance({
      issueWithIv: issueSourceCapabilityWithIv,
      verify: verifySourceCapability,
    });
  });

  it("matches the canonical URL fixtures", () => {
    const rendition = { width: 640, quality: 75 };
    expect(
      buildPublicResolverUrl("example-public", "uploadthing", "project/file one", rendition),
    ).toBe(URL_FIXTURES.publicResolver);
    expect(
      buildPublicLocatedSourceUrl("example-public", "source/one", "capability.token", rendition),
    ).toBe(URL_FIXTURES.publicLocated);
    expect(buildPublicMasterUrl("example-public", "video", "source/one", rendition)).toBe(
      URL_FIXTURES.publicMaster,
    );
    expect(buildPrivateSourceUrl("example-private", "capability.token", rendition)).toBe(
      URL_FIXTURES.privateSource,
    );
    expect(buildPrivateMasterUrl("example-private", "capability.token", rendition)).toBe(
      URL_FIXTURES.privateMaster,
    );
    expect(buildPreviewJobUrl("example-private", "source/one", "pdf")).toBe(
      URL_FIXTURES.previewJob,
    );
    expect(buildSourcePurgeUrl("example-private", "source/one")).toBe(URL_FIXTURES.sourcePurge);
  });

  it("matches the cache identity fixtures", async () => {
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
