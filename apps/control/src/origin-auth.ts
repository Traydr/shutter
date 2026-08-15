import { createHash, timingSafeEqual } from "node:crypto";

function credentialDigest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time check of an internal `Authorization: Bearer` header against a
 * configured token. Fails closed on a missing or short token so an
 * unconfigured route can never be opened by an empty header.
 */
export function bearerAuthorized(
  header: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (expectedToken === undefined || expectedToken.length < 32 || header === undefined)
    return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(
    credentialDigest(header.slice(prefix.length)),
    credentialDigest(expectedToken),
  );
}
