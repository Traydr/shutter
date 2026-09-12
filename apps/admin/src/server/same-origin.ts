/**
 * Whether a state-changing request came from this site. The session cookie
 * is SameSite=Strict, so a cross-site request would arrive without it; this
 * check is the second lock for browsers that send Sec-Fetch-Site or Origin.
 */
export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) return fetchSite === "same-origin" || fetchSite === "none";
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
