import type {
  CapabilityKeyMaterial,
  RenditionCacheIdentity,
  SourceCapabilityClaims,
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

export const URL_FIXTURES = Object.freeze({
  publicResolver: "/v1/public/example-public/resolver/uploadthing/project%2Ffile%20one?w=640&q=75",
  publicLocated: "/v1/public/example-public/located/source%2Fone/capability.token?w=640&q=75",
  publicMaster: "/v1/public/example-public/master/video/source%2Fone?w=640&q=75",
  privateSource: "/v1/private/example-private/source/capability.token?w=640&q=75",
  privateMaster: "/v1/private/example-private/master/capability.token?w=640&q=75",
  previewJob: "/v1/spaces/example-private/sources/source%2Fone/previews/pdf",
  sourcePurge: "/v1/spaces/example-private/sources/source%2Fone/purge",
});

export const CACHE_IDENTITY_FIXTURE: Readonly<RenditionCacheIdentity> = Object.freeze({
  routeClass: "private",
  spaceId: "example-private",
  sourceId: "sha256:fixture-source",
  input: Object.freeze({ type: "master", kind: "video" }),
  width: 640,
  quality: 75,
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

    const verified = await adapter.verify(token, {
      spaceId: fixture.claims.space_id,
      expectedPurpose: fixture.claims.purpose,
      expectedSourceId: fixture.claims.source_id,
      ...(fixture.claims.purpose === "master_preview" || fixture.claims.purpose === "preview_job"
        ? { expectedKind: fixture.claims.kind }
        : {}),
      keys,
      now: TEST_CAPABILITY_NOW,
      allowedSourceOrigins: TEST_SOURCE_ORIGINS,
    });
    if (canonicalJson(verified) !== canonicalJson(fixture.claims)) {
      throw new Error(`${fixture.name}: decoded claims drifted`);
    }
  }
}
