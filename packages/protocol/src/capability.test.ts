import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { verifySourceCapability } from "./capability.js";
import { CapabilityError } from "./errors.js";
import { issueSourceCapabilityWithIv } from "./testing.js";
import type { ImageSourceClaims, SourceCapabilityClaims } from "./types.js";

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const kid = "test-key";
const iv = Uint8Array.from({ length: 12 }, (_, index) => index);
const originRules = [{ origin: "https://sources.example.test", pathPrefix: "/objects" }];
const claims: ImageSourceClaims = {
  space_id: "test-space",
  source_id: "source-01",
  purpose: "image_source",
  iat: 1_800_000_000,
  exp: 1_800_003_600,
  locator: "https://sources.example.test/objects/source-01?signature=test",
};

async function tokenFor(value: SourceCapabilityClaims = claims): Promise<string> {
  return Effect.runPromise(issueSourceCapabilityWithIv(value, { kid, key }, iv));
}

function verification(overrides = {}) {
  return {
    spaceId: "test-space",
    expectedPurpose: "image_source" as const,
    keys: new Map([[kid, key]]),
    now: 1_800_000_060,
    allowedSourceOrigins: originRules,
    ...overrides,
  };
}

describe("source capabilities", () => {
  it("fails authentication for tampering, wrong Space, and wrong purpose", async () => {
    const token = await tokenFor();
    const final = token.at(-1) === "A" ? "B" : "A";
    await expect(
      Effect.runPromise(verifySourceCapability(`${token.slice(0, -1)}${final}`, verification())),
    ).rejects.toMatchObject({
      code: "authentication_failed",
    });
    await expect(
      Effect.runPromise(verifySourceCapability(token, verification({ spaceId: "other-space" }))),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(
      Effect.runPromise(
        verifySourceCapability(token, verification({ expectedPurpose: "master_preview" })),
      ),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("rejects unknown versions and key IDs before decryption", async () => {
    const token = await tokenFor();
    await expect(
      Effect.runPromise(verifySourceCapability(token.replace(/^v1/u, "v2"), verification())),
    ).rejects.toMatchObject({
      code: "unknown_version",
    });
    await expect(
      Effect.runPromise(verifySourceCapability(token.replace(kid, "retired-key"), verification())),
    ).rejects.toMatchObject({
      code: "unknown_key",
    });
  });

  it("rejects expired, future-issued, and overlong capabilities", async () => {
    const token = await tokenFor();
    await expect(
      Effect.runPromise(verifySourceCapability(token, verification({ now: claims.exp }))),
    ).rejects.toMatchObject({ code: "capability_expired" });

    const future = await tokenFor({ ...claims, iat: 1_800_000_100, exp: 1_800_003_700 });
    await expect(
      Effect.runPromise(verifySourceCapability(future, verification())),
    ).rejects.toMatchObject({
      code: "capability_not_yet_valid",
    });

    await expect(
      Effect.runPromise(verifySourceCapability(`v1.${"x".repeat(9_000)}`, verification())),
    ).rejects.toMatchObject({
      code: "capability_too_large",
    });
  });

  it("rejects unsafe and non-allowlisted locators", async () => {
    await expect(
      tokenFor({ ...claims, locator: "http://sources.example.test/objects/source-01" }),
    ).rejects.toBeInstanceOf(CapabilityError);
    await expect(
      tokenFor({ ...claims, locator: "https://sources.example.test/other/source-01" }).then(
        (token) => Effect.runPromise(verifySourceCapability(token, verification())),
      ),
    ).rejects.toMatchObject({ code: "locator_not_allowed" });
  });

  it("rejects unexpected claim fields", async () => {
    await expect(
      tokenFor({ ...claims, extra: true } as unknown as ImageSourceClaims),
    ).rejects.toMatchObject({ code: "claims_invalid" });
  });

  it("surfaces an internal fault as a defect rather than an invalid capability", async () => {
    // A bug inside verification is not a caller error. If it were folded into the
    // typed channel it would answer `403 claims_invalid` and hide the fault;
    // callers must still see `503 service_unavailable`.
    const hostileKeys = {
      get() {
        throw new TypeError("registry lookup is broken");
      },
    } as unknown as ReadonlyMap<string, Uint8Array>;

    const exit = await Effect.runPromiseExit(
      verifySourceCapability(await tokenFor(), verification({ keys: hostileKeys })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
    }
  });
});
