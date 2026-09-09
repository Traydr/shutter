import { describe, expect, it } from "vitest";
import {
  type AccessTokenClaims,
  issueAccessTokenWithIvInternal,
  verifyAccessToken,
} from "./access-token.js";

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const kid = "test-key";
const iv = Uint8Array.from({ length: 12 }, (_, index) => index);
const claims: AccessTokenClaims = {
  space_id: "test-space",
  source_id: "media/source-01",
  purpose: "image_source",
  iat: 1_800_000_000,
  exp: 1_800_003_600,
};

function tokenFor(value: AccessTokenClaims = claims): Promise<string> {
  return issueAccessTokenWithIvInternal(value, { kid, key }, iv);
}

function verification(overrides = {}) {
  return {
    spaceId: "test-space",
    expectedPurpose: "image_source" as const,
    expectedSourceId: "media/source-01",
    keys: new Map([[kid, key]]),
    now: 1_800_000_060,
    ...overrides,
  };
}

describe("access tokens", () => {
  it("round-trips claims through a v2 envelope with no locator", async () => {
    const token = await tokenFor();
    expect(token.startsWith("v2.test-key.")).toBe(true);
    expect(token.split(".")).toHaveLength(4);
    await expect(verifyAccessToken(token, verification())).resolves.toEqual(claims);
  });

  it("binds a Master Preview token to its kind", async () => {
    const master: AccessTokenClaims = { ...claims, purpose: "master_preview", kind: "video" };
    const token = await tokenFor(master);
    await expect(
      verifyAccessToken(
        token,
        verification({ expectedPurpose: "master_preview", expectedKind: "video" }),
      ),
    ).resolves.toEqual(master);
    await expect(
      verifyAccessToken(
        token,
        verification({ expectedPurpose: "master_preview", expectedKind: "pdf" }),
      ),
    ).rejects.toMatchObject({ code: "kind_mismatch" });
    await expect(tokenFor({ ...claims, kind: "video" })).rejects.toMatchObject({
      code: "claims_invalid",
    });
    await expect(tokenFor({ ...claims, purpose: "master_preview" })).rejects.toMatchObject({
      code: "claims_invalid",
    });
  });

  it("fails authentication for tampering, another Space, and another purpose", async () => {
    const token = await tokenFor();
    const final = token.at(-1) === "A" ? "B" : "A";
    await expect(
      verifyAccessToken(`${token.slice(0, -1)}${final}`, verification()),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(
      verifyAccessToken(token, verification({ spaceId: "other-space" })),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(
      verifyAccessToken(token, verification({ expectedPurpose: "source_delivery" })),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("refuses another reference, a v1 envelope, an unknown key, and bad times", async () => {
    const token = await tokenFor();
    await expect(
      verifyAccessToken(token, verification({ expectedSourceId: "media/other" })),
    ).rejects.toMatchObject({ code: "source_mismatch" });
    await expect(
      verifyAccessToken(token.replace(/^v2/u, "v1"), verification()),
    ).rejects.toMatchObject({ code: "unknown_version" });
    await expect(
      verifyAccessToken(token.replace(kid, "retired"), verification()),
    ).rejects.toMatchObject({ code: "unknown_key" });
    await expect(
      verifyAccessToken(token, verification({ now: 1_800_003_600 })),
    ).rejects.toMatchObject({ code: "capability_expired" });
    await expect(
      verifyAccessToken(token, verification({ now: 1_799_999_999 })),
    ).rejects.toMatchObject({ code: "capability_not_yet_valid" });
    await expect(tokenFor({ ...claims, exp: claims.iat + 86_401 })).rejects.toMatchObject({
      code: "claims_invalid",
    });
  });

  it("never accepts a locator claim", async () => {
    await expect(
      // SAFETY: the test deliberately passes an extra field the claims type does not have.
      tokenFor({ ...claims, locator: "https://x" } as AccessTokenClaims),
    ).rejects.toMatchObject({ code: "claims_invalid" });
  });
});
