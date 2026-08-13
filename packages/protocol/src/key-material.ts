import { decodeBase64Url, encodeBase64Url } from "./base64url.js";

const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/u;

export function decodeCapabilityKey(value: string): Uint8Array {
  const key = HEX_KEY_PATTERN.test(value)
    ? Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16))
    : decodeBase64Url(value);
  if (key.byteLength !== 32) {
    throw new Error(`capability key must decode to 32 bytes (got ${key.byteLength})`);
  }
  return key;
}

export function encodeCapabilityKey(key: Uint8Array): string {
  if (key.byteLength !== 32) throw new Error("capability key must contain 32 bytes");
  return encodeBase64Url(key);
}
