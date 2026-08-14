import {
  buildCanonicalCacheUrl,
  buildMasterPreviewKey,
  buildMasterPurgePrefix,
  buildPreviewJobUrl,
  buildPrivateDeliveryUrl,
  buildPrivateMasterUrl,
  buildPrivateSourceUrl,
  buildPublicLocatedDeliveryUrl,
  buildPublicLocatedSourceUrl,
  buildPublicMasterUrl,
  buildPublicResolverDeliveryUrl,
  buildPublicResolverUrl,
  buildR2CacheKey,
  buildR2CachePurgePrefix,
  buildSourceCacheTag,
  buildSourceDeliveryCacheUrl,
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
  SOURCE_DELIVERY_CACHE_IDENTITY_FIXTURE,
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
    const parameters = { width: 640, quality: 75 };
    expect(
      buildPublicResolverUrl("example-public", "uploadthing", "project/file one", parameters),
    ).toBe(URL_FIXTURES.publicResolver);
    expect(
      buildPublicLocatedSourceUrl("example-public", "source/one", "capability.token", parameters),
    ).toBe(URL_FIXTURES.publicLocated);
    expect(
      buildPublicResolverDeliveryUrl("example-public", "uploadthing", "project/file one"),
    ).toBe(URL_FIXTURES.publicResolverDelivery);
    expect(buildPublicLocatedDeliveryUrl("example-public", "source/one", "capability.token")).toBe(
      URL_FIXTURES.publicLocatedDelivery,
    );
    expect(buildPublicMasterUrl("example-public", "video", "source/one", parameters)).toBe(
      URL_FIXTURES.publicMaster,
    );
    expect(buildPrivateSourceUrl("example-private", "capability.token", parameters)).toBe(
      URL_FIXTURES.privateSource,
    );
    expect(buildPrivateDeliveryUrl("example-private", "capability.token")).toBe(
      URL_FIXTURES.privateDelivery,
    );
    expect(buildPrivateMasterUrl("example-private", "capability.token", parameters)).toBe(
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
    await expect(buildSourceDeliveryCacheUrl(SOURCE_DELIVERY_CACHE_IDENTITY_FIXTURE)).resolves.toBe(
      CACHE_IDENTITY_EXPECTED.sourceDeliveryUrl,
    );
  });
});
