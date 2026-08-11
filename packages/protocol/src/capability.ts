import { Effect } from "effect";
import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import { copyBytes, encodeUtf8, frameStrings } from "./binary.js";
import {
  CAPABILITY_IV_BYTES,
  CAPABILITY_KEY_BYTES,
  CAPABILITY_MAX_BYTES,
  CAPABILITY_MAX_LIFETIME_SECONDS,
  CAPABILITY_TAG_BITS,
  PROTOCOL_VERSION,
  SOURCE_ID_MAX_BYTES,
  SOURCE_LOCATOR_MAX_BYTES,
} from "./constants.js";
import { CapabilityError, type CapabilityErrorCode } from "./errors.js";
import type { CapabilityPurpose, SourceCapabilityClaims, SourceOriginRule } from "./types.js";

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type CapabilityKeyMaterial = Uint8Array | CryptoKey;

export interface IssueCapabilityOptions {
  kid: string;
  key: CapabilityKeyMaterial;
}

export interface VerifyCapabilityOptions<Purpose extends CapabilityPurpose> {
  spaceId: string;
  expectedPurpose: Purpose;
  keys: ReadonlyMap<string, CapabilityKeyMaterial>;
  now: number;
  allowedSourceOrigins?: readonly SourceOriginRule[];
  expectedSourceId?: string;
  expectedKind?: "video" | "pdf";
}

type ClaimsForPurpose<Purpose extends CapabilityPurpose> = Extract<
  SourceCapabilityClaims,
  { purpose: Purpose }
>;

function capabilityError(code: CapabilityErrorCode, message: string): CapabilityError {
  return new CapabilityError({ code, message });
}

/**
 * Runs a synchronous capability step, keeping deliberate `CapabilityError`
 * throws in the typed error channel and letting anything else become a defect.
 *
 * An unexpected throw here is a bug in Shutter, not an invalid capability.
 * Converting it to `claims_invalid` would answer a caller with `403` and hide
 * the defect; dying keeps the caller's `503 service_unavailable`, matching the
 * behaviour before capabilities returned Effects.
 */
function tryCapability<A>(thunk: () => A): Effect.Effect<A, CapabilityError> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(thunk());
    } catch (error) {
      return error instanceof CapabilityError ? Effect.fail(error) : Effect.die(error);
    }
  });
}

function isCryptoKey(value: CapabilityKeyMaterial): value is CryptoKey {
  return "algorithm" in value && "usages" in value;
}

function importKey(
  key: CapabilityKeyMaterial,
  usage: KeyUsage,
): Effect.Effect<CryptoKey, CapabilityError> {
  if (isCryptoKey(key)) return Effect.succeed(key);
  if (key.byteLength !== CAPABILITY_KEY_BYTES) {
    return Effect.fail(capabilityError("claims_invalid", "capability keys must be 256 bits"));
  }
  return Effect.promise(() =>
    crypto.subtle.importKey("raw", copyBytes(key), { name: "AES-GCM" }, false, [usage]),
  );
}

function associatedData(
  spaceId: string,
  kid: string,
  purpose: CapabilityPurpose,
): Uint8Array<ArrayBuffer> {
  return frameStrings([PROTOCOL_VERSION, spaceId, kid, purpose]);
}

function validateKid(kid: string): void {
  if (!KEY_ID_PATTERN.test(kid)) {
    throw capabilityError("capability_malformed", "key ID is not a valid envelope segment");
  }
}

function expectedClaimKeys(purpose: CapabilityPurpose): readonly string[] {
  if (purpose === "image_source") {
    return ["exp", "iat", "locator", "purpose", "source_id", "space_id"];
  }
  if (purpose === "master_preview") {
    return ["exp", "iat", "kind", "purpose", "source_id", "space_id"];
  }
  return ["exp", "iat", "kind", "locator", "purpose", "source_id", "space_id"];
}

export function validateSourceLocator(
  locator: string,
  rules: readonly SourceOriginRule[],
): Effect.Effect<void, CapabilityError> {
  return tryCapability(() => validateLocator(locator, rules));
}

function validateLocator(locator: string, rules: readonly SourceOriginRule[]): void {
  if (encodeUtf8(locator).byteLength > SOURCE_LOCATOR_MAX_BYTES) {
    throw capabilityError("claims_invalid", "source locator is too large");
  }

  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw capabilityError("locator_not_allowed", "source locator must be an absolute URL");
  }

  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw capabilityError(
      "locator_not_allowed",
      "source locator must be HTTPS without credentials or a fragment",
    );
  }

  const allowed = rules.some((rule) => {
    let origin: URL;
    try {
      origin = new URL(rule.origin);
    } catch {
      return false;
    }
    if (origin.origin !== url.origin || origin.pathname !== "/" || origin.search || origin.hash) {
      return false;
    }
    if (rule.pathPrefix === undefined || rule.pathPrefix === "/") return true;
    const normalizedPrefix = rule.pathPrefix.startsWith("/")
      ? rule.pathPrefix.replace(/\/+$/u, "")
      : `/${rule.pathPrefix.replace(/\/+$/u, "")}`;
    return url.pathname === normalizedPrefix || url.pathname.startsWith(`${normalizedPrefix}/`);
  });

  if (!allowed) {
    throw capabilityError("locator_not_allowed", "source locator is not allowlisted");
  }
}

function validateClaims(
  input: unknown,
  options: VerifyCapabilityOptions<CapabilityPurpose>,
): SourceCapabilityClaims {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw capabilityError("claims_invalid", "capability claims must be a JSON object");
  }
  const record = input as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...expectedClaimKeys(options.expectedPurpose)].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw capabilityError("claims_invalid", "capability claims contain missing or unknown fields");
  }

  if (record.space_id !== options.spaceId) {
    throw capabilityError("space_mismatch", "capability Space does not match the route");
  }
  if (record.purpose !== options.expectedPurpose) {
    throw capabilityError("purpose_mismatch", "capability purpose does not match the route");
  }
  if (typeof record.source_id !== "string" || record.source_id.length === 0) {
    throw capabilityError("claims_invalid", "source ID must be a non-empty string");
  }
  if (encodeUtf8(record.source_id).byteLength > SOURCE_ID_MAX_BYTES) {
    throw capabilityError("claims_invalid", "source ID is too large");
  }
  if (options.expectedSourceId !== undefined && record.source_id !== options.expectedSourceId) {
    throw capabilityError("source_mismatch", "capability Source ID does not match the route");
  }
  if (!Number.isSafeInteger(record.iat) || !Number.isSafeInteger(record.exp)) {
    throw capabilityError("claims_invalid", "capability times must be integer Unix seconds");
  }

  const issuedAt = record.iat as number;
  const expiresAt = record.exp as number;
  if (issuedAt > options.now) {
    throw capabilityError("capability_not_yet_valid", "capability was issued in the future");
  }
  if (expiresAt <= options.now) {
    throw capabilityError("capability_expired", "capability has expired");
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > CAPABILITY_MAX_LIFETIME_SECONDS) {
    throw capabilityError("claims_invalid", "capability lifetime is invalid");
  }

  if (options.expectedPurpose === "image_source" || options.expectedPurpose === "preview_job") {
    if (typeof record.locator !== "string") {
      throw capabilityError("claims_invalid", "this capability purpose requires a locator");
    }
    validateLocator(record.locator, options.allowedSourceOrigins ?? []);
  }

  if (options.expectedPurpose === "master_preview" || options.expectedPurpose === "preview_job") {
    if (record.kind !== "video" && record.kind !== "pdf") {
      throw capabilityError("claims_invalid", "preview kind must be video or pdf");
    }
    if (options.expectedKind !== undefined && record.kind !== options.expectedKind) {
      throw capabilityError("kind_mismatch", "capability kind does not match the route");
    }
  }

  return record as unknown as SourceCapabilityClaims;
}

function canonicalClaimsJson(claims: SourceCapabilityClaims): string {
  const common = {
    space_id: claims.space_id,
    source_id: claims.source_id,
    purpose: claims.purpose,
    iat: claims.iat,
    exp: claims.exp,
  };
  if (claims.purpose === "image_source") {
    return JSON.stringify({ ...common, locator: claims.locator });
  }
  if (claims.purpose === "master_preview") {
    return JSON.stringify({ ...common, kind: claims.kind });
  }
  return JSON.stringify({ ...common, kind: claims.kind, locator: claims.locator });
}

export function issueSourceCapability(
  claims: SourceCapabilityClaims,
  options: IssueCapabilityOptions,
): Effect.Effect<string, CapabilityError> {
  return tryCapability(() => crypto.getRandomValues(new Uint8Array(CAPABILITY_IV_BYTES))).pipe(
    Effect.flatMap((iv) => issueSourceCapabilityWithIvInternal(claims, options, iv)),
  );
}

export function issueSourceCapabilityWithIvInternal(
  claims: SourceCapabilityClaims,
  options: IssueCapabilityOptions,
  ivInput: Uint8Array,
): Effect.Effect<string, CapabilityError> {
  return Effect.gen(function* () {
    yield* tryCapability(() => {
      validateKid(options.kid);
      if (ivInput.byteLength !== CAPABILITY_IV_BYTES) {
        throw capabilityError("claims_invalid", "AES-GCM IV must be 96 bits");
      }

      // Issuance applies the same strict shape, lifetime, and locator checks as verification.
      let issuanceOrigin = "https://invalid.shutter.invalid";
      if (claims.purpose !== "master_preview") {
        try {
          issuanceOrigin = new URL(claims.locator).origin;
        } catch {
          // validateClaims returns the stable protocol error for malformed locators.
        }
      }
      validateClaims(claims, {
        spaceId: claims.space_id,
        expectedPurpose: claims.purpose,
        keys: new Map(),
        now: claims.iat,
        allowedSourceOrigins:
          claims.purpose === "master_preview" ? [] : [{ origin: issuanceOrigin }],
      });
    });

    const key = yield* importKey(options.key, "encrypt");
    const iv = copyBytes(ivInput);
    const ciphertext = yield* Effect.promise(() =>
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: associatedData(claims.space_id, options.kid, claims.purpose),
          tagLength: CAPABILITY_TAG_BITS,
        },
        key,
        encodeUtf8(canonicalClaimsJson(claims)),
      ),
    );

    const token = `${PROTOCOL_VERSION}.${options.kid}.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
    if (token.length > CAPABILITY_MAX_BYTES) {
      return yield* Effect.fail(
        capabilityError("capability_too_large", "capability exceeds the v1 envelope limit"),
      );
    }
    return token;
  });
}

export function verifySourceCapability<Purpose extends CapabilityPurpose>(
  token: string,
  options: VerifyCapabilityOptions<Purpose>,
): Effect.Effect<ClaimsForPurpose<Purpose>, CapabilityError> {
  return Effect.gen(function* () {
    const envelope = yield* tryCapability(() => {
      if (token.length > CAPABILITY_MAX_BYTES) {
        throw capabilityError("capability_too_large", "capability exceeds the v1 envelope limit");
      }
      const parts = token.split(".");
      if (parts.length !== 4) {
        throw capabilityError(
          "capability_malformed",
          "capability envelope must contain four segments",
        );
      }
      const [version, kid, ivValue, ciphertextValue] = parts as [string, string, string, string];
      if (version !== PROTOCOL_VERSION) {
        throw capabilityError("unknown_version", "capability version is not supported");
      }
      validateKid(kid);
      const keyMaterial = options.keys.get(kid);
      if (keyMaterial === undefined) {
        throw capabilityError("unknown_key", "capability key is not active");
      }

      const iv = decodeBase64Url(ivValue);
      if (iv.byteLength !== CAPABILITY_IV_BYTES) {
        throw capabilityError("capability_malformed", "capability IV must be 96 bits");
      }
      return { kid, keyMaterial, iv, ciphertext: decodeBase64Url(ciphertextValue) };
    });

    const key = yield* importKey(envelope.keyMaterial, "decrypt");
    const plaintext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: envelope.iv,
            additionalData: associatedData(options.spaceId, envelope.kid, options.expectedPurpose),
            tagLength: CAPABILITY_TAG_BITS,
          },
          key,
          envelope.ciphertext,
        ),
      catch: () => capabilityError("authentication_failed", "capability authentication failed"),
    });

    const parsed = yield* Effect.try({
      try: () => JSON.parse(textDecoder.decode(plaintext)) as unknown,
      catch: () =>
        capabilityError("claims_invalid", "capability plaintext is not valid UTF-8 JSON"),
    });

    return yield* tryCapability(() => validateClaims(parsed, options) as ClaimsForPurpose<Purpose>);
  });
}
