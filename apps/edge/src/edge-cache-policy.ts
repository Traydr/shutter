import type { RouteClass } from "@shutter/protocol";

const PRIVATE_EDGE_TTL_SECONDS = 86_400;
const PUBLIC_BROWSER_TTL_SECONDS = 86_400;
const PUBLIC_EDGE_TTL_SECONDS = 2_592_000;

export function internalEdgeCacheResponse(
  response: Response,
  routeClass: RouteClass,
  cacheTag: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "cache-control",
    `public, max-age=${
      routeClass === "private" ? PRIVATE_EDGE_TTL_SECONDS : PUBLIC_EDGE_TTL_SECONDS
    }`,
  );
  headers.set("cache-tag", cacheTag);
  return new Response(response.body, { status: response.status, headers });
}

export function edgeBrowserResponse(
  response: Response,
  options: {
    routeClass: RouteClass;
    cacheStatus: string;
    cacheTag: string;
    head?: boolean;
  },
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-shutter-cache", options.cacheStatus);
  // A 416 keyed to the bare URL, or a cold partial, must never enter a
  // downstream cache: the public delivery URL is stable and embedded in pages,
  // and Source Purge cannot reach browser caches.
  const uncacheableDownstream =
    response.status === 416 || (response.status === 206 && options.cacheStatus === "origin");
  if (options.routeClass === "private" || uncacheableDownstream) {
    headers.set("cache-control", "private, no-store");
    headers.delete("cache-tag");
  } else {
    headers.set(
      "cache-control",
      `public, max-age=${PUBLIC_BROWSER_TTL_SECONDS}, s-maxage=${PUBLIC_EDGE_TTL_SECONDS}`,
    );
    headers.set("cache-tag", options.cacheTag);
  }
  return new Response(options.head === true ? null : response.body, {
    status: response.status,
    headers,
  });
}
