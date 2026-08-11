import { it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { afterEach, describe, expect, vi } from "vitest";
import { issueSourceCapability, verifySourceCapability } from "./capability.js";
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

afterEach(() => {
  vi.restoreAllMocks();
});

function tokenFor(value: SourceCapabilityClaims = claims) {
  return issueSourceCapabilityWithIv(value, { kid, key }, iv);
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
  it.effect("fails authentication for tampering, wrong Space, and wrong purpose", () =>
    Effect.gen(function* () {
      const token = yield* tokenFor();
      const final = token.at(-1) === "A" ? "B" : "A";
      expect(
        yield* Effect.flip(verifySourceCapability(`${token.slice(0, -1)}${final}`, verification())),
      ).toMatchObject({ code: "authentication_failed" });
      expect(
        yield* Effect.flip(verifySourceCapability(token, verification({ spaceId: "other-space" }))),
      ).toMatchObject({ code: "authentication_failed" });
      expect(
        yield* Effect.flip(
          verifySourceCapability(token, verification({ expectedPurpose: "master_preview" })),
        ),
      ).toMatchObject({ code: "authentication_failed" });
    }),
  );

  it.effect("rejects unknown versions and key IDs before decryption", () =>
    Effect.gen(function* () {
      const token = yield* tokenFor();
      expect(
        yield* Effect.flip(verifySourceCapability(token.replace(/^v1/u, "v2"), verification())),
      ).toMatchObject({ code: "unknown_version" });
      expect(
        yield* Effect.flip(
          verifySourceCapability(token.replace(kid, "retired-key"), verification()),
        ),
      ).toMatchObject({ code: "unknown_key" });
    }),
  );

  it.effect("rejects expired, future-issued, and overlong capabilities", () =>
    Effect.gen(function* () {
      const token = yield* tokenFor();
      expect(
        yield* Effect.flip(verifySourceCapability(token, verification({ now: claims.exp }))),
      ).toMatchObject({ code: "capability_expired" });

      const future = yield* tokenFor({ ...claims, iat: 1_800_000_100, exp: 1_800_003_700 });
      expect(yield* Effect.flip(verifySourceCapability(future, verification()))).toMatchObject({
        code: "capability_not_yet_valid",
      });

      expect(
        yield* Effect.flip(verifySourceCapability(`v1.${"x".repeat(9_000)}`, verification())),
      ).toMatchObject({ code: "capability_too_large" });
    }),
  );

  it.effect("rejects unsafe and non-allowlisted locators", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          tokenFor({ ...claims, locator: "http://sources.example.test/objects/source-01" }),
        ),
      ).toBeInstanceOf(CapabilityError);
      const token = yield* tokenFor({
        ...claims,
        locator: "https://sources.example.test/other/source-01",
      });
      expect(yield* Effect.flip(verifySourceCapability(token, verification()))).toMatchObject({
        code: "locator_not_allowed",
      });
    }),
  );

  it.effect("rejects unexpected claim fields", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(tokenFor({ ...claims, extra: true } as unknown as ImageSourceClaims)),
      ).toMatchObject({ code: "claims_invalid" });
    }),
  );

  it.effect("surfaces an internal fault as a defect rather than an invalid capability", () =>
    Effect.gen(function* () {
      // A bug inside verification is not a caller error. If it were folded into the
      // typed channel it would answer `403 claims_invalid` and hide the fault;
      // callers must still see `503 service_unavailable`.
      const hostileKeys = {
        get() {
          throw new TypeError("registry lookup is broken");
        },
      } as unknown as ReadonlyMap<string, Uint8Array>;

      const token = yield* tokenFor();
      const exit = yield* Effect.exit(
        verifySourceCapability(token, verification({ keys: hostileKeys })),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.hasFails(exit.cause)).toBe(false);
      }
    }),
  );

  it.effect("surfaces a key import failure as a defect", () =>
    Effect.gen(function* () {
      vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(
        new TypeError("WebCrypto key import is unavailable"),
      );

      const exit = yield* Effect.exit(tokenFor());

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.hasFails(exit.cause)).toBe(false);
      }
    }),
  );

  it.effect("surfaces an IV generation failure as a defect", () =>
    Effect.gen(function* () {
      vi.spyOn(crypto, "getRandomValues").mockImplementationOnce(() => {
        throw new TypeError("WebCrypto randomness is unavailable");
      });

      const exit = yield* Effect.exit(issueSourceCapability(claims, { kid, key }));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.hasFails(exit.cause)).toBe(false);
      }
    }),
  );

  it.effect("surfaces an encryption failure as a defect", () =>
    Effect.gen(function* () {
      vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(
        new TypeError("WebCrypto encryption is unavailable"),
      );

      const exit = yield* Effect.exit(tokenFor());

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.hasFails(exit.cause)).toBe(false);
      }
    }),
  );
});
