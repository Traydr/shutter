import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SpaceRegistryError } from "./registry.js";

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export function createApiToken(): string {
  return `shutter_api_${randomBytes(32).toString("base64url")}`;
}

export function validateApiToken(token: string): void {
  if (token.length < 32 || token.length > 256) {
    throw new SpaceRegistryError("invalid", "an API token must contain from 32 to 256 characters");
  }
}

export function apiTokenHash(token: string): string {
  validateApiToken(token);
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function apiTokenMatches(token: string, candidateHash: string): boolean {
  return apiTokenHashMatches(apiTokenHash(token), candidateHash);
}

export function apiTokenHashMatches(actualHash: string, candidateHash: string): boolean {
  const actual = Buffer.from(actualHash, "hex");
  const candidate = Buffer.from(candidateHash, "hex");
  return actual.byteLength === candidate.byteLength && timingSafeEqual(actual, candidate);
}

export function apiTokenDisplayPrefix(token: string): string {
  return token.slice(0, 16);
}

export function validateCapabilityKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new SpaceRegistryError("invalid", "a Capability Key identifier is not valid");
  }
}

export function createCapabilityKey(): Uint8Array {
  return Uint8Array.from(randomBytes(32));
}

export function encodeCapabilityKey(key: Uint8Array): string {
  if (key.byteLength !== 32) {
    throw new SpaceRegistryError("invalid", "a Capability Key must contain 32 bytes");
  }
  return Buffer.from(key).toString("base64url");
}
