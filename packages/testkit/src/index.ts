import type {
  AccessTokenClaims,
  CapabilityKeyMaterial,
  OptimizationCacheIdentity,
  S3ResolverPolicy,
  SourceCapabilityClaims,
  SourceDeliveryCacheIdentity,
  TemplateResolverPolicy,
  VerifyAccessTokenOptions,
  VerifyCapabilityOptions,
} from "@shutter/protocol";

export const TEST_CAPABILITY_KID = "fixture-key-2026-07";
export const TEST_CAPABILITY_KEY = Uint8Array.from([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
  27, 28, 29, 30, 31,
]);
export const TEST_CAPABILITY_NOW = 1_800_000_060;
export const TEST_SOURCE_ORIGINS = Object.freeze([
  Object.freeze({ origin: "https://sources.example.test", pathPrefix: "/objects" }),
]);

export interface CapabilityFixture {
  name: string;
  claims: SourceCapabilityClaims;
  iv: Uint8Array;
  expectedToken: string;
}

export const CAPABILITY_FIXTURES: readonly CapabilityFixture[] = Object.freeze([
  Object.freeze({
    name: "image source",
    claims: Object.freeze({
      space_id: "fixture-space",
      source_id: "image/source 01",
      purpose: "image_source",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
      locator: "https://sources.example.test/objects/image-01?signature=test",
    }),
    iv: Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    expectedToken:
      "v1.fixture-key-2026-07.AAECAwQFBgcICQoL.PCCla6SGp0TkJbWxk48RFfej9VHdCC8dWwLHqT8ab8dzc8ujxqUwolbNEozv4gdLgSwS7j_2k-sduwhpbZGFgYNZ5EDxuEsAezH1HYD6fItdqOVAHwInSsfMpvxIwIm9-8hpyoYksGq8Jg-KeEURT4lRUpvP50n1Lp4jovDEVCzTJnS2x-3kfHuOPdNevz_sU4yCWEV99mT4OpsD1b2LhPb06mbGlqEfwAbwyu6_9dL6oKtW_tkWgRG6s7NTuF3Hbtg2jPjUy839pXuzVJA",
  }),
  Object.freeze({
    name: "source delivery",
    claims: Object.freeze({
      space_id: "fixture-space",
      source_id: "delivery-source-01",
      purpose: "source_delivery",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
      locator: "https://sources.example.test/objects/delivery.mp4?signature=test",
    }),
    iv: Uint8Array.from([36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]),
    expectedToken:
      "v1.fixture-key-2026-07.JCUmJygpKissLS4v.iK3QrkItOHZQg0cvN_IvbbfjCc97fqJZuVNLa7OFsRtnifk3wzCn_LEkVVSOpaRLT5zjoAS0xGPCSE0UyIf4D2Ut3trQdSTsfxkGC9xYM-W4aMejBjeQwbtrf_jZivIVnRGjznvEERu9F3Zin-TN5R9MsCHI2yXYqTZWpZEzYzUFuKOeboRApvy13-ucipwMIBg1cidHItN7SH-rue4sH0MzbS5CIRl6rAdXK7ZAMwzjLbSBp3sGT-LY95bEvoApMiWo9HQ90fFFL6A4FughntrCU_YLWu-z",
  }),
  Object.freeze({
    name: "master preview",
    claims: Object.freeze({
      space_id: "fixture-space",
      source_id: "video-source-01",
      purpose: "master_preview",
      kind: "video",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    }),
    iv: Uint8Array.from([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]),
    expectedToken:
      "v1.fixture-key-2026-07.DA0ODxAREhMUFRYX.49waqB4VmQxeTmrvs-1PnyF2n4vbDkvL-MfYzMbTr49elA96iKEEWz2FZzaLwzep4yPJsszZJIJs01gsz58612hPYvHT370igR3FJDB-b_5TTbtlffRpV-IP9fomlBWrhZPu2A0aeMER_Qmf2KYUwFEfTwrFTwFWDomq_kHHxlhWg44SVT0AnnxtCOWh-RiDT6Yn_CSy",
  }),
  Object.freeze({
    name: "preview job",
    claims: Object.freeze({
      space_id: "fixture-space",
      source_id: "pdf-source-01",
      purpose: "preview_job",
      kind: "pdf",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
      locator: "https://sources.example.test/objects/document.pdf?signature=test",
    }),
    iv: Uint8Array.from([24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]),
    expectedToken:
      "v1.fixture-key-2026-07.GBkaGxwdHh8gISIj.aD0zYLoqABBoZ5_zcb2pNmSMiCO2IYVlABICrK5MrR8ADEuEyuwG5oSBjUWIrCSgj1SLe-hdKYBZThXj3VDFUBzwtSdTkRsGxnihOR3xQ1he_7Tv5jhCDi_g4Ssm1mdAzClJ3P_VwoyKG9Kx9_mjFPvPlFYp3awn3j14C_CqZs-PWHVzj-6aizU_21qDfoP3LF3W_A7AS113UymXoF-AwCyPA8Y6kSpWy243qC6om7cxAH6jI5yhY0QkTYUXroTb8Me9I-jJK5iFBok2LSuRGZq36XZ86JEhcyYHFg",
  }),
]);

export interface AccessTokenFixture {
  name: string;
  claims: AccessTokenClaims;
  iv: Uint8Array;
  expectedToken: string;
}

/** v2 access tokens (ADR 0028): one per purpose, pinned byte for byte. */
export const ACCESS_TOKEN_FIXTURES: readonly AccessTokenFixture[] = Object.freeze([
  Object.freeze({
    name: "source delivery",
    claims: Object.freeze({
      space_id: "fixture-space",
      source_id: "media/file.one",
      purpose: "source_delivery",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    }),
    iv: Uint8Array.from([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59]),
    expectedToken:
      "v2.fixture-key-2026-07.MDEyMzQ1Njc4OTo7.yBdCsIgML1xDV6zWMP9XEOhSPTLuTTRkRNtzYMrAEUsxA2k7RaS5nYxJdy0Tp_xLxyA4Z0TfoAWBYhEhMjg-hzVEhK3nxkJNk37GMgMDFbZZq0khr-d7vnHEAYNbYC_Y-4dmKWBUJWgm2TlqNc_ZIQ9UfW9gdh5yt4QhvCAoWhui3vMtUSfL",
  }),
  Object.freeze({
    name: "image source",
    claims: Object.freeze({
      space_id: "fixture-space",
      source_id: "media/file.one",
      purpose: "image_source",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    }),
    iv: Uint8Array.from([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]),
    expectedToken:
      "v2.fixture-key-2026-07.PD0-P0BBQkNERUZH.DPxKgJUssOjFxk0WDCwVWdFp6RAP_lAoQWOG6gqKfyWRS0TaEb9mhnbxB84tgkQAwIjf7iIkSByhmZPrLRj-igmwVsYcXdFl2PbMpkMlAPCZktpO2ixsu9nmXO8oC5JVhO2IW80KrBuqzeWWzNQ18AJGTuqUsn0fN_rKfaQCUj1LKGmB",
  }),
  Object.freeze({
    name: "master preview",
    claims: Object.freeze({
      space_id: "fixture-space",
      source_id: "media/tour.mp4",
      purpose: "master_preview",
      kind: "video",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    }),
    iv: Uint8Array.from([72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83]),
    expectedToken:
      "v2.fixture-key-2026-07.SElKS0xNTk9QUVJT.tQ_4ExSCfBCxJBVHTEZACkvPfDQTqMTMkFGRy__gz89pos3C5QbgRyjdXcZHeGhiCVI5ftYuIwYU4u2shzCrLZwDmtquTxSWAw8IGl-b7IOQBlLNcSSb6NfwK1wHN_5cEL3DNUVs-3KMm9ZYbANUVtnpOJM4qK8UBp_0ElTa3nSSPvwTQPqM0Gr5GacGZgaiJLWKtI4",
  }),
]);

export const URL_FIXTURES = Object.freeze({
  publicLocated: "/v1/public/example-public/located/source%2Fone/capability.token?w=640&q=75",
  publicLocatedDelivery: "/v1/public/example-public/delivery/located/source%2Fone/capability.token",
  publicMaster: "/v1/public/example-public/master/video/source%2Fone?w=640&q=75",
  privateSource: "/v1/private/example-private/source/capability.token?w=640&q=75",
  privateDelivery: "/v1/private/example-private/delivery/capability.token",
  privateMaster: "/v1/private/example-private/master/capability.token?w=640&q=75",
  previewJob: "/v1/spaces/example-private/sources/source%2Fone/previews/pdf",
  sourcePurge: "/v1/spaces/example-private/sources/source%2Fone/purge",
});

/** One v2 Delivery URL per operation and route class, from the same reference. */
export const V2_URL_FIXTURES = Object.freeze({
  delivery: "/v2/example-public/media/file.one",
  optimization: "/v2/example-public/media/file.one?w=640&q=75",
  preview: "/v2/example-public/media/file.one?preview=video&w=640&q=75",
  twoSegments: "/v2/example-public/ut/example-project/file_9?w=640&q=75",
  privateDelivery: "/v2/example-private/media/file.one?token=v2.token",
  privateOptimization: "/v2/example-private/media/file.one?w=640&q=75&token=v2.token",
  previewJob: "/v2/spaces/example-public/sources/media%2Ffile.one/previews/video",
  sourcePurge: "/v2/spaces/example-public/sources/media%2Ffile.one/purge",
});

/** The template resolver every consumer and service test agrees on, with its allowed origin. */
export const TEMPLATE_RESOLVER_FIXTURE: Readonly<TemplateResolverPolicy> = Object.freeze({
  id: "ut",
  type: "template",
  url: "https://{project}.ufs.sh/f/{file}",
  placeholders: Object.freeze({
    project: Object.freeze({ allowed: Object.freeze(["example-project"]) }),
    file: Object.freeze({}),
  }),
});
export const TEMPLATE_RESOLVER_ORIGIN = Object.freeze({
  origin: "https://example-project.ufs.sh",
  pathPrefix: "/f",
});

/** The S3 resolver fixture; its credential is whatever the test under way supplies. */
export const S3_RESOLVER_FIXTURE: Readonly<S3ResolverPolicy> = Object.freeze({
  id: "media",
  type: "s3",
  endpoint: "https://objects.example.test",
  region: "auto",
  bucket: "example-bucket",
  pathStyle: true,
  keyTemplate: "originals/{key}",
});
export const S3_RESOLVER_ORIGIN = Object.freeze({
  origin: "https://objects.example.test",
  pathPrefix: "/example-bucket",
});

/** What the fixtures resolve to; any resolver implementation must agree byte for byte. */
export const RESOLVER_EXPECTED = Object.freeze({
  templateSourceId: "ut/example-project/file_9",
  templateLocator: "https://example-project.ufs.sh/f/file_9",
  s3SourceId: "media/file.one",
  s3Key: "originals/file.one",
  s3Url: "https://objects.example.test/example-bucket/originals/file.one",
});

export const CACHE_IDENTITY_FIXTURE: Readonly<OptimizationCacheIdentity> = Object.freeze({
  routeClass: "private",
  spaceId: "example-private",
  sourceId: "sha256:fixture-source",
  input: Object.freeze({ type: "master", kind: "video" }),
  width: 640,
  quality: 75,
});

export const SOURCE_DELIVERY_CACHE_IDENTITY_FIXTURE: Readonly<SourceDeliveryCacheIdentity> =
  Object.freeze({
    routeClass: "private",
    spaceId: CACHE_IDENTITY_FIXTURE.spaceId,
    sourceId: CACHE_IDENTITY_FIXTURE.sourceId,
  });

export const CACHE_IDENTITY_EXPECTED = Object.freeze({
  fingerprint: "iukmE_DLjqEZ4a1OL3XXVcrPxnoR-aPpRVAhE0w0VBc",
  r2Key:
    "cache/v1/private/example-private/iukmE_DLjqEZ4a1OL3XXVcrPxnoR-aPpRVAhE0w0VBc/master-video/w640-q75.webp",
  masterKey: "masters/v1/example-private/iukmE_DLjqEZ4a1OL3XXVcrPxnoR-aPpRVAhE0w0VBc/video.webp",
  cachePrefix: "cache/v1/private/example-private/iukmE_DLjqEZ4a1OL3XXVcrPxnoR-aPpRVAhE0w0VBc/",
  masterPrefix: "masters/v1/example-private/iukmE_DLjqEZ4a1OL3XXVcrPxnoR-aPpRVAhE0w0VBc/",
  cacheTag: "shutter-v1-iukmE_DLjqEZ4a1OL3XXVcrPxnoR-aPpRVAhE0w0VBc",
  canonicalUrl:
    "https://cache.shutter.invalid/cache/v1/private/example-private/iukmE_DLjqEZ4a1OL3XXVcrPxnoR-aPpRVAhE0w0VBc/master-video/w640-q75.webp",
  sourceDeliveryUrl:
    "https://cache.shutter.invalid/source/v1/private/example-private/iukmE_DLjqEZ4a1OL3XXVcrPxnoR-aPpRVAhE0w0VBc",
});

export interface CapabilityConformanceAdapter {
  issueWithIv(
    claims: SourceCapabilityClaims,
    options: { kid: string; key: CapabilityKeyMaterial },
    iv: Uint8Array,
  ): Promise<string>;
  verify(
    token: string,
    options: VerifyCapabilityOptions<SourceCapabilityClaims["purpose"]>,
  ): Promise<SourceCapabilityClaims>;
}

/** Claims are flat, so a key-sorted replacer list yields one canonical spelling. */
function canonicalClaims(claims: SourceCapabilityClaims): string {
  return JSON.stringify(claims, Object.keys(claims).sort());
}

export async function runCapabilityConformance(
  adapter: CapabilityConformanceAdapter,
): Promise<void> {
  const keys = new Map<string, CapabilityKeyMaterial>([[TEST_CAPABILITY_KID, TEST_CAPABILITY_KEY]]);

  for (const fixture of CAPABILITY_FIXTURES) {
    const token = await adapter.issueWithIv(
      fixture.claims,
      { kid: TEST_CAPABILITY_KID, key: TEST_CAPABILITY_KEY },
      fixture.iv,
    );
    if (token !== fixture.expectedToken) {
      throw new Error(
        `${fixture.name}: token fixture drifted\nexpected ${fixture.expectedToken}\nreceived ${token}`,
      );
    }

    const verification: VerifyCapabilityOptions<SourceCapabilityClaims["purpose"]> = {
      spaceId: fixture.claims.space_id,
      expectedPurpose: fixture.claims.purpose,
      expectedSourceId: fixture.claims.source_id,
      keys,
      now: TEST_CAPABILITY_NOW,
      allowedSourceOrigins: TEST_SOURCE_ORIGINS,
    };
    if ("kind" in fixture.claims) verification.expectedKind = fixture.claims.kind;
    const verified = await adapter.verify(token, verification);
    if (canonicalClaims(verified) !== canonicalClaims(fixture.claims)) {
      throw new Error(`${fixture.name}: decoded claims drifted`);
    }
  }
}

export interface AccessTokenConformanceAdapter {
  issueWithIv(
    claims: AccessTokenClaims,
    options: { kid: string; key: CapabilityKeyMaterial },
    iv: Uint8Array,
  ): Promise<string>;
  verify(
    token: string,
    options: VerifyAccessTokenOptions<AccessTokenClaims["purpose"]>,
  ): Promise<AccessTokenClaims>;
}

function canonicalTokenClaims(claims: AccessTokenClaims): string {
  return JSON.stringify(claims, Object.keys(claims).sort());
}

export async function runAccessTokenConformance(
  adapter: AccessTokenConformanceAdapter,
): Promise<void> {
  const keys = new Map<string, CapabilityKeyMaterial>([[TEST_CAPABILITY_KID, TEST_CAPABILITY_KEY]]);
  for (const fixture of ACCESS_TOKEN_FIXTURES) {
    const token = await adapter.issueWithIv(
      fixture.claims,
      { kid: TEST_CAPABILITY_KID, key: TEST_CAPABILITY_KEY },
      fixture.iv,
    );
    if (token !== fixture.expectedToken) {
      throw new Error(
        `${fixture.name}: token fixture drifted\nexpected ${fixture.expectedToken}\nreceived ${token}`,
      );
    }
    const verification: VerifyAccessTokenOptions<AccessTokenClaims["purpose"]> = {
      spaceId: fixture.claims.space_id,
      expectedPurpose: fixture.claims.purpose,
      expectedSourceId: fixture.claims.source_id,
      keys,
      now: TEST_CAPABILITY_NOW,
    };
    if (fixture.claims.kind !== undefined) verification.expectedKind = fixture.claims.kind;
    const verified = await adapter.verify(token, verification);
    if (canonicalTokenClaims(verified) !== canonicalTokenClaims(fixture.claims)) {
      throw new Error(`${fixture.name}: decoded claims drifted`);
    }
  }
}
