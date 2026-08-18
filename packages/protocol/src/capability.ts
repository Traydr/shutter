import { z } from "zod";
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
import { ProtocolError } from "./errors.js";
import type { JsonValue } from "./json.js";
import { normalizeSourceOriginPathPrefix } from "./space-policy.js";
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

function isCryptoKey(value: CapabilityKeyMaterial): value is CryptoKey {
  return "algorithm" in value && "usages" in value;
}

async function importKey(key: CapabilityKeyMaterial, usage: KeyUsage): Promise<CryptoKey> {
  if (isCryptoKey(key)) return key;
  if (key.byteLength !== CAPABILITY_KEY_BYTES) {
    throw new ProtocolError("claims_invalid", "capability keys must be 256 bits");
  }
  return crypto.subtle.importKey("raw", copyBytes(key), { name: "AES-GCM" }, false, [usage]);
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
    throw new ProtocolError("capability_malformed", "key ID is not a valid envelope segment");
  }
}

const PURPOSE_CLAIM_FIELDS = {
  image_source: { locator: true, kind: false },
  source_delivery: { locator: true, kind: false },
  master_preview: { locator: false, kind: true },
  preview_job: { locator: true, kind: true },
} as const satisfies Record<CapabilityPurpose, { locator: boolean; kind: boolean }>;

function purposeClaimFields(purpose: CapabilityPurpose) {
  return PURPOSE_CLAIM_FIELDS[purpose];
}

function expectedClaimKeys(purpose: CapabilityPurpose): readonly string[] {
  const fields = purposeClaimFields(purpose);
  return [
    "exp",
    "iat",
    ...(fields.kind ? ["kind"] : []),
    ...(fields.locator ? ["locator"] : []),
    "purpose",
    "source_id",
    "space_id",
  ];
}

export function validateSourceLocator(locator: string, rules: readonly SourceOriginRule[]): void {
  validateLocator(locator, rules);
}

function validateLocator(locator: string, rules: readonly SourceOriginRule[]): void {
  if (encodeUtf8(locator).byteLength > SOURCE_LOCATOR_MAX_BYTES) {
    throw new ProtocolError("claims_invalid", "source locator is too large");
  }

  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new ProtocolError("locator_not_allowed", "source locator must be an absolute URL");
  }

  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new ProtocolError(
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
    const normalizedPrefix = normalizeSourceOriginPathPrefix(rule.pathPrefix);
    if (normalizedPrefix === "/") return true;
    return url.pathname === normalizedPrefix || url.pathname.startsWith(`${normalizedPrefix}/`);
  });

  if (!allowed) throw new ProtocolError("locator_not_allowed", "source locator is not allowlisted");
}

/**
 * The claim fields as they appear in decrypted capability plaintext, before the
 * per-purpose field set, lifetime, and locator rules have been enforced.
 */
const claimsCandidateSchema = z.strictObject(
  {
    space_id: z.string({ error: "Space ID must be a string" }),
    source_id: z.string({ error: "source ID must be a non-empty string" }),
    purpose: z.string({ error: "purpose must be a string" }),
    iat: z.int({ error: "capability times must be integer Unix seconds" }),
    exp: z.int({ error: "capability times must be integer Unix seconds" }),
    locator: z.string({ error: "locator must be a string" }).optional(),
    kind: z.string({ error: "preview kind must be video or pdf" }).optional(),
  },
  { error: "capability claims must be a JSON object with only the v1 claim fields" },
);

type CapabilityClaimsCandidate = z.output<typeof claimsCandidateSchema>;

function parseClaimsCandidate(
  input: JsonValue | SourceCapabilityClaims,
): CapabilityClaimsCandidate {
  const parsed = claimsCandidateSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new ProtocolError(
    "claims_invalid",
    parsed.error.issues[0]?.message ?? "capability claims are invalid",
  );
}

function validateClaims(
  record: CapabilityClaimsCandidate,
  options: VerifyCapabilityOptions<CapabilityPurpose>,
): SourceCapabilityClaims {
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...expectedClaimKeys(options.expectedPurpose)].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ProtocolError(
      "claims_invalid",
      "capability claims contain missing or unknown fields",
    );
  }

  if (record.space_id !== options.spaceId) {
    throw new ProtocolError("space_mismatch", "capability Space does not match the route");
  }
  if (record.purpose !== options.expectedPurpose) {
    throw new ProtocolError("purpose_mismatch", "capability purpose does not match the route");
  }
  if (record.source_id.length === 0) {
    throw new ProtocolError("claims_invalid", "source ID must be a non-empty string");
  }
  if (encodeUtf8(record.source_id).byteLength > SOURCE_ID_MAX_BYTES) {
    throw new ProtocolError("claims_invalid", "source ID is too large");
  }
  if (options.expectedSourceId !== undefined && record.source_id !== options.expectedSourceId) {
    throw new ProtocolError("source_mismatch", "capability Source ID does not match the route");
  }

  const issuedAt = record.iat;
  const expiresAt = record.exp;
  if (issuedAt > options.now) {
    throw new ProtocolError("capability_not_yet_valid", "capability was issued in the future");
  }
  if (expiresAt <= options.now) {
    throw new ProtocolError("capability_expired", "capability has expired");
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > CAPABILITY_MAX_LIFETIME_SECONDS) {
    throw new ProtocolError("claims_invalid", "capability lifetime is invalid");
  }

  const common = {
    space_id: record.space_id,
    source_id: record.source_id,
    iat: issuedAt,
    exp: expiresAt,
  };

  const locator = record.locator;
  if (locator !== undefined) validateLocator(locator, options.allowedSourceOrigins ?? []);
  const kind = record.kind;
  if (kind !== undefined) {
    if (kind !== "video" && kind !== "pdf") {
      throw new ProtocolError("claims_invalid", "preview kind must be video or pdf");
    }
    if (options.expectedKind !== undefined && kind !== options.expectedKind) {
      throw new ProtocolError("kind_mismatch", "capability kind does not match the route");
    }
  }

  // The exact-key check above guarantees each purpose carries precisely the
  // fields its representation requires; the branches below re-establish that
  // for the type system without asserting.
  const purpose = options.expectedPurpose;
  if (purpose === "image_source" || purpose === "source_delivery") {
    if (locator === undefined)
      throw new ProtocolError("claims_invalid", "purpose requires locator");
    return { ...common, purpose, locator };
  }
  if (kind !== "video" && kind !== "pdf") {
    throw new ProtocolError("claims_invalid", "purpose requires kind");
  }
  if (purpose === "master_preview") return { ...common, purpose, kind };
  if (locator === undefined) throw new ProtocolError("claims_invalid", "purpose requires locator");
  return { ...common, purpose, kind, locator };
}

function canonicalClaimsJson(claims: SourceCapabilityClaims): string {
  const common = {
    space_id: claims.space_id,
    source_id: claims.source_id,
    purpose: claims.purpose,
    iat: claims.iat,
    exp: claims.exp,
  };
  switch (claims.purpose) {
    case "image_source":
    case "source_delivery":
      return JSON.stringify({ ...common, locator: claims.locator });
    case "master_preview":
      return JSON.stringify({ ...common, kind: claims.kind });
    case "preview_job":
      return JSON.stringify({ ...common, kind: claims.kind, locator: claims.locator });
  }
}

export async function issueSourceCapability(
  claims: SourceCapabilityClaims,
  options: IssueCapabilityOptions,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(CAPABILITY_IV_BYTES));
  return issueSourceCapabilityWithIvInternal(claims, options, iv);
}

export async function issueSourceCapabilityWithIvInternal(
  claims: SourceCapabilityClaims,
  options: IssueCapabilityOptions,
  ivInput: Uint8Array,
): Promise<string> {
  validateKid(options.kid);
  if (ivInput.byteLength !== CAPABILITY_IV_BYTES) {
    throw new ProtocolError("claims_invalid", "AES-GCM IV must be 96 bits");
  }

  // Issuance applies the same strict field, lifetime, and locator checks as verification.
  const fields = purposeClaimFields(claims.purpose);
  let issuanceOrigin = "https://invalid.shutter.invalid";
  if ("locator" in claims) {
    try {
      issuanceOrigin = new URL(claims.locator).origin;
    } catch {
      // validateClaims returns the stable protocol error for malformed locators.
    }
  }
  validateClaims(parseClaimsCandidate(claims), {
    spaceId: claims.space_id,
    expectedPurpose: claims.purpose,
    keys: new Map(),
    now: claims.iat,
    allowedSourceOrigins: fields.locator ? [{ origin: issuanceOrigin }] : [],
  });

  const key = await importKey(options.key, "encrypt");
  const iv = copyBytes(ivInput);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: associatedData(claims.space_id, options.kid, claims.purpose),
      tagLength: CAPABILITY_TAG_BITS,
    },
    key,
    encodeUtf8(canonicalClaimsJson(claims)),
  );

  const token = `${PROTOCOL_VERSION}.${options.kid}.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
  if (token.length > CAPABILITY_MAX_BYTES) {
    throw new ProtocolError("capability_too_large", "capability exceeds the v1 envelope limit");
  }
  return token;
}

export async function verifySourceCapability<Purpose extends CapabilityPurpose>(
  token: string,
  options: VerifyCapabilityOptions<Purpose>,
): Promise<ClaimsForPurpose<Purpose>> {
  if (token.length > CAPABILITY_MAX_BYTES) {
    throw new ProtocolError("capability_too_large", "capability exceeds the v1 envelope limit");
  }
  const parts = token.split(".");
  if (parts.length !== 4) {
    throw new ProtocolError(
      "capability_malformed",
      "capability envelope must contain four segments",
    );
  }
  // SAFETY: the length check above proves the split produced exactly four segments.
  const [version, kid, ivValue, ciphertextValue] = parts as [string, string, string, string];
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError("unknown_version", "capability version is not supported");
  }
  validateKid(kid);
  const keyMaterial = options.keys.get(kid);
  if (keyMaterial === undefined)
    throw new ProtocolError("unknown_key", "capability key is not active");

  const iv = decodeBase64Url(ivValue);
  if (iv.byteLength !== CAPABILITY_IV_BYTES) {
    throw new ProtocolError("capability_malformed", "capability IV must be 96 bits");
  }
  const ciphertext = decodeBase64Url(ciphertextValue);
  const key = await importKey(keyMaterial, "decrypt");

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
      ciphertext,
    );
  } catch {
    throw new ProtocolError("authentication_failed", "capability authentication failed");
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(textDecoder.decode(plaintext));
  } catch {
    throw new ProtocolError("claims_invalid", "capability plaintext is not valid UTF-8 JSON");
  }

  // SAFETY: validateClaims rejects any claims whose purpose differs from
  // options.expectedPurpose, so the returned member is the one for Purpose.
  return validateClaims(parseClaimsCandidate(parsed), options) as ClaimsForPurpose<Purpose>;
}
