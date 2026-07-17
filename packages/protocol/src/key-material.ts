import { decodeBase64Url } from "./base64url.js";

const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/u;

export type CapabilityKeyRegistry = ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;

export function decodeCapabilityKey(value: string): Uint8Array {
  const key = HEX_KEY_PATTERN.test(value)
    ? Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16))
    : decodeBase64Url(value);
  if (key.byteLength !== 32) {
    throw new Error(`capability key must decode to 32 bytes (got ${key.byteLength})`);
  }
  return key;
}

export function parseCapabilityKeyRegistry(value: string): CapabilityKeyRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CAPABILITY_KEYS must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CAPABILITY_KEYS must be an object keyed by Space ID");
  }

  const registry = new Map<string, ReadonlyMap<string, Uint8Array>>();
  for (const [spaceId, rawKeys] of Object.entries(parsed)) {
    if (typeof rawKeys !== "object" || rawKeys === null || Array.isArray(rawKeys)) {
      throw new Error(`CAPABILITY_KEYS.${spaceId} must be an object keyed by key ID`);
    }
    const keys = new Map<string, Uint8Array>();
    for (const [kid, rawKey] of Object.entries(rawKeys)) {
      if (typeof rawKey !== "string") {
        throw new Error(`CAPABILITY_KEYS.${spaceId}.${kid} must be a string`);
      }
      keys.set(kid, decodeCapabilityKey(rawKey));
    }
    registry.set(spaceId, keys);
  }
  return registry;
}
