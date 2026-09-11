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
  buildR2CacheKey,
  buildR2CachePurgePrefix,
  buildSourceCacheTag,
  buildSourceDeliveryCacheUrl,
  buildSourcePurgeUrl,
  buildV2DeliveryUrl,
  buildV2PreviewJobUrl,
  buildV2SourcePurgeUrl,
  expandS3Resolver,
  expandTemplateResolver,
  parseSourceReference,
  sourceFingerprint,
  verifyAccessToken,
  verifySourceCapability,
} from "@shutter/protocol";
import { issueAccessTokenWithIv, issueSourceCapabilityWithIv } from "@shutter/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  CACHE_IDENTITY_EXPECTED,
  CACHE_IDENTITY_FIXTURE,
  RESOLVER_EXPECTED,
  runAccessTokenConformance,
  runCapabilityConformance,
  S3_RESOLVER_FIXTURE,
  SOURCE_DELIVERY_CACHE_IDENTITY_FIXTURE,
  TEMPLATE_RESOLVER_FIXTURE,
  URL_FIXTURES,
  V2_URL_FIXTURES,
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
      buildPublicLocatedSourceUrl("example-public", "source/one", "capability.token", parameters),
    ).toBe(URL_FIXTURES.publicLocated);
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

  it("matches the shared access token fixtures", async () => {
    await runAccessTokenConformance({
      issueWithIv: issueAccessTokenWithIv,
      verify: verifyAccessToken,
    });
  });

  it("matches the v2 URL fixtures", () => {
    const reference = ["file.one"];
    expect(buildV2DeliveryUrl("example-public", "media", reference)).toBe(V2_URL_FIXTURES.delivery);
    expect(
      buildV2DeliveryUrl("example-public", "media", reference, { width: 640, quality: 75 }),
    ).toBe(V2_URL_FIXTURES.optimization);
    expect(
      buildV2DeliveryUrl("example-public", "media", reference, {
        preview: "video",
        width: 640,
        quality: 75,
      }),
    ).toBe(V2_URL_FIXTURES.preview);
    expect(
      buildV2DeliveryUrl("example-public", "ut", ["example-project", "file_9"], {
        width: 640,
        quality: 75,
      }),
    ).toBe(V2_URL_FIXTURES.twoSegments);
    expect(buildV2DeliveryUrl("example-private", "media", reference, { token: "v2.token" })).toBe(
      V2_URL_FIXTURES.privateDelivery,
    );
    expect(
      buildV2DeliveryUrl("example-private", "media", reference, {
        width: 640,
        quality: 75,
        token: "v2.token",
      }),
    ).toBe(V2_URL_FIXTURES.privateOptimization);
    expect(buildV2PreviewJobUrl("example-public", "media/file.one", "video")).toBe(
      V2_URL_FIXTURES.previewJob,
    );
    expect(buildV2SourcePurgeUrl("example-public", "media/file.one")).toBe(
      V2_URL_FIXTURES.sourcePurge,
    );
  });

  it("matches the resolver fixtures", () => {
    const template = parseSourceReference(TEMPLATE_RESOLVER_FIXTURE, ["example-project", "file_9"]);
    expect(template?.sourceId).toBe(RESOLVER_EXPECTED.templateSourceId);
    expect(expandTemplateResolver(TEMPLATE_RESOLVER_FIXTURE, template?.values ?? [])).toBe(
      RESOLVER_EXPECTED.templateLocator,
    );
    const s3 = parseSourceReference(S3_RESOLVER_FIXTURE, ["file.one"]);
    expect(s3?.sourceId).toBe(RESOLVER_EXPECTED.s3SourceId);
    expect(expandS3Resolver(S3_RESOLVER_FIXTURE, s3?.values ?? [])).toEqual({
      key: RESOLVER_EXPECTED.s3Key,
      url: RESOLVER_EXPECTED.s3Url,
    });
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
