import { createHash, timingSafeEqual } from "node:crypto";

function credentialDigest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time check of an internal `Authorization: Bearer` header against
 * the token `configuredToken` returns. Fails closed on a missing or short
 * token so an unconfigured route can never be opened by an empty header. The
 * configured token is digested once, and again only if it changes, so a
 * request hashes only the token it presented.
 */
export function bearerCheck(
  configuredToken: () => string | undefined,
): (header: string | undefined) => boolean {
  let expected: { token: string; digest: Uint8Array } | undefined;

  return (header) => {
    const token = configuredToken();
    if (token === undefined || token.length < 32 || header === undefined) return false;
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) return false;
    if (expected?.token !== token) expected = { token, digest: credentialDigest(token) };

    return timingSafeEqual(credentialDigest(header.slice(prefix.length)), expected.digest);
  };
}
