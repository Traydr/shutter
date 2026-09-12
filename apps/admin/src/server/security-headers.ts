/**
 * Every response the app serves is an operator page or a server-function
 * answer, so nothing may be cached, framed, or embedded. Scripts stay
 * unrestricted by the policy because Start hydrates through inline script;
 * the framing, object, base, and form rules are the ones that matter here.
 */
export const CONTENT_SECURITY_POLICY =
  "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

export function applySecurityHeaders(headers: Headers): void {
  headers.set("cache-control", "private, no-store");
  headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  headers.set("referrer-policy", "same-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
}
