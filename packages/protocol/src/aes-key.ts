import { copyBytes } from "./binary.js";
import { CAPABILITY_KEY_BYTES } from "./constants.js";
import { ProtocolError } from "./errors.js";

/**
 * The AES-GCM key handling every sealed envelope shares: v1 Source
 * Capabilities and v2 access tokens must agree on the key-ID grammar and the
 * 256-bit key rule forever, so both take them from here.
 */

/** Raw 256-bit key bytes, or a key already imported for AES-GCM. */
export type CapabilityKeyMaterial = Uint8Array | CryptoKey;

export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function isCryptoKey(value: CapabilityKeyMaterial): value is CryptoKey {
  return "algorithm" in value && "usages" in value;
}

export async function importAesGcmKey(
  key: CapabilityKeyMaterial,
  usage: KeyUsage,
): Promise<CryptoKey> {
  if (isCryptoKey(key)) return key;
  if (key.byteLength !== CAPABILITY_KEY_BYTES) {
    throw new ProtocolError("claims_invalid", "capability keys must be 256 bits");
  }

  return crypto.subtle.importKey("raw", copyBytes(key), { name: "AES-GCM" }, false, [usage]);
}

/**
 * Imports a key-ID map once as non-extractable AES-GCM decryption keys, so a
 * holder that verifies many envelopes with the same keys (the Edge, per config
 * snapshot) does not re-import raw bytes for every request. The keys can only
 * decrypt, which is all verification needs.
 */
export async function importVerificationKeys(
  keys: ReadonlyMap<string, Uint8Array>,
): Promise<ReadonlyMap<string, CryptoKey>> {
  const imported = await Promise.all(
    Array.from(
      keys,
      async ([keyId, key]) => [keyId, await importAesGcmKey(key, "decrypt")] as const,
    ),
  );

  return new Map(imported);
}
