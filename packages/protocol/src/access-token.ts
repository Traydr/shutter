import { z } from "zod";
import { importAesGcmKey, KEY_ID_PATTERN, utf8Decoder } from "./aes-key.js";
import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import { copyBytes, encodeUtf8, frameStrings } from "./binary.js";
import type { CapabilityKeyMaterial, IssueCapabilityOptions } from "./capability.js";
import {
  CAPABILITY_IV_BYTES,
  CAPABILITY_MAX_BYTES,
  CAPABILITY_MAX_LIFETIME_SECONDS,
  CAPABILITY_TAG_BITS,
  SOURCE_ID_MAX_BYTES,
} from "./constants.js";
import { ProtocolError } from "./errors.js";
import type { JsonValue } from "./json.js";
import type { PreviewKind } from "./types.js";

/**
 * The v2 private-Space credential (ADR 0028): the Source Capability envelope
 * at version `v2` with no locator inside. It binds one Source ID to one
 * purpose and an expiry; where the bytes live is the resolver's business.
 */
export const ACCESS_TOKEN_VERSION = "v2" as const;

export type AccessTokenPurpose = "source_delivery" | "image_source" | "master_preview";

export interface AccessTokenClaims {
  space_id: string;
  source_id: string;
  purpose: AccessTokenPurpose;
  /** Present exactly when the purpose is `master_preview`. */
  kind?: PreviewKind | undefined;
  iat: number;
  exp: number;
}

export interface VerifyAccessTokenOptions<Purpose extends AccessTokenPurpose> {
  spaceId: string;
  expectedPurpose: Purpose;
  expectedSourceId: string;
  expectedKind?: PreviewKind | undefined;
  keys: ReadonlyMap<string, CapabilityKeyMaterial>;
  now: number;
}

function associatedData(spaceId: string, kid: string, purpose: AccessTokenPurpose) {
  return frameStrings([ACCESS_TOKEN_VERSION, spaceId, kid, purpose]);
}

const claimsSchema = z.strictObject(
  {
    space_id: z.string({ error: "Space ID must be a string" }),
    source_id: z.string({ error: "source ID must be a non-empty string" }).min(1),
    purpose: z.enum(["source_delivery", "image_source", "master_preview"], {
      error: "purpose must be source_delivery, image_source, or master_preview",
    }),
    kind: z.enum(["video", "pdf"], { error: "preview kind must be video or pdf" }).optional(),
    iat: z.int({ error: "token times must be integer Unix seconds" }),
    exp: z.int({ error: "token times must be integer Unix seconds" }),
  },
  { error: "access token claims must be a JSON object with only the v2 claim fields" },
);

function parseClaims(input: JsonValue | AccessTokenClaims): AccessTokenClaims {
  const parsed = claimsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProtocolError(
      "claims_invalid",
      parsed.error.issues[0]?.message ?? "access token claims are invalid",
    );
  }
  const claims = parsed.data;
  if ((claims.purpose === "master_preview") !== (claims.kind !== undefined)) {
    throw new ProtocolError("claims_invalid", "kind is present exactly for master_preview");
  }
  if (encodeUtf8(claims.source_id).byteLength > SOURCE_ID_MAX_BYTES) {
    throw new ProtocolError("claims_invalid", "source ID is too large");
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > CAPABILITY_MAX_LIFETIME_SECONDS) {
    throw new ProtocolError("claims_invalid", "token lifetime is invalid");
  }
  const result: AccessTokenClaims = {
    space_id: claims.space_id,
    source_id: claims.source_id,
    purpose: claims.purpose,
    iat: claims.iat,
    exp: claims.exp,
  };
  if (claims.kind !== undefined) result.kind = claims.kind;
  return result;
}

/** One canonical spelling per claim set, so the same claims always encrypt to the same bytes. */
function canonicalJson(claims: AccessTokenClaims): string {
  const { space_id, source_id, purpose, kind, iat, exp } = claims;
  return JSON.stringify(
    kind === undefined
      ? { space_id, source_id, purpose, iat, exp }
      : { space_id, source_id, purpose, kind, iat, exp },
  );
}

export async function issueAccessToken(
  claims: AccessTokenClaims,
  options: IssueCapabilityOptions,
): Promise<string> {
  return issueAccessTokenWithIvInternal(
    claims,
    options,
    crypto.getRandomValues(new Uint8Array(CAPABILITY_IV_BYTES)),
  );
}

export async function issueAccessTokenWithIvInternal(
  claims: AccessTokenClaims,
  options: IssueCapabilityOptions,
  ivInput: Uint8Array,
): Promise<string> {
  if (!KEY_ID_PATTERN.test(options.kid)) {
    throw new ProtocolError("capability_malformed", "key ID is not a valid envelope segment");
  }
  if (ivInput.byteLength !== CAPABILITY_IV_BYTES) {
    throw new ProtocolError("claims_invalid", "AES-GCM IV must be 96 bits");
  }
  const validated = parseClaims(claims);
  const key = await importAesGcmKey(options.key, "encrypt");
  const iv = copyBytes(ivInput);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: associatedData(validated.space_id, options.kid, validated.purpose),
      tagLength: CAPABILITY_TAG_BITS,
    },
    key,
    encodeUtf8(canonicalJson(validated)),
  );
  const token = `${ACCESS_TOKEN_VERSION}.${options.kid}.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
  if (token.length > CAPABILITY_MAX_BYTES) {
    throw new ProtocolError("capability_too_large", "token exceeds the envelope limit");
  }
  return token;
}

/**
 * Decrypts and validates a v2 access token for one route: the Space, purpose,
 * and Source ID must all match, the kind too for a Master Preview, and the
 * token must be inside its lifetime.
 */
export async function verifyAccessToken<Purpose extends AccessTokenPurpose>(
  token: string,
  options: VerifyAccessTokenOptions<Purpose>,
): Promise<AccessTokenClaims & { purpose: Purpose }> {
  if (token.length > CAPABILITY_MAX_BYTES) {
    throw new ProtocolError("capability_too_large", "token exceeds the envelope limit");
  }
  const parts = token.split(".");
  if (parts.length !== 4) {
    throw new ProtocolError("capability_malformed", "token envelope must contain four segments");
  }
  // SAFETY: the length check above proves the split produced exactly four segments.
  const [version, kid, ivValue, ciphertextValue] = parts as [string, string, string, string];
  if (version !== ACCESS_TOKEN_VERSION) {
    throw new ProtocolError("unknown_version", "token version is not supported");
  }
  if (!KEY_ID_PATTERN.test(kid)) {
    throw new ProtocolError("capability_malformed", "key ID is not a valid envelope segment");
  }
  const keyMaterial = options.keys.get(kid);
  if (keyMaterial === undefined) throw new ProtocolError("unknown_key", "token key is not active");
  const iv = decodeBase64Url(ivValue);
  if (iv.byteLength !== CAPABILITY_IV_BYTES) {
    throw new ProtocolError("capability_malformed", "token IV must be 96 bits");
  }
  const key = await importAesGcmKey(keyMaterial, "decrypt");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: associatedData(options.spaceId, kid, options.expectedPurpose),
        tagLength: CAPABILITY_TAG_BITS,
      },
      key,
      decodeBase64Url(ciphertextValue),
    );
  } catch {
    throw new ProtocolError("authentication_failed", "token authentication failed");
  }
  let decoded: JsonValue;
  try {
    decoded = JSON.parse(utf8Decoder.decode(plaintext));
  } catch {
    throw new ProtocolError("claims_invalid", "token plaintext is not valid UTF-8 JSON");
  }
  const claims = parseClaims(decoded);
  if (claims.space_id !== options.spaceId) {
    throw new ProtocolError("space_mismatch", "token Space does not match the route");
  }
  if (claims.purpose !== options.expectedPurpose) {
    throw new ProtocolError("purpose_mismatch", "token purpose does not match the operation");
  }
  if (claims.source_id !== options.expectedSourceId) {
    throw new ProtocolError("source_mismatch", "token Source ID does not match the reference");
  }
  if (options.expectedKind !== undefined && claims.kind !== options.expectedKind) {
    throw new ProtocolError("kind_mismatch", "token kind does not match the preview");
  }
  if (claims.iat > options.now) {
    throw new ProtocolError("capability_not_yet_valid", "token was issued in the future");
  }
  if (claims.exp <= options.now) {
    throw new ProtocolError("capability_expired", "token has expired");
  }
  // SAFETY: the purpose comparison above proved claims.purpose is options.expectedPurpose.
  return claims as AccessTokenClaims & { purpose: Purpose };
}
