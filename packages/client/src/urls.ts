import {
  buildV2DeliveryUrl,
  type DeliveryUrlOptions,
  isReferenceSegment,
  isResolverId,
  type PreviewKind,
  resolverSourceId,
} from "@shutter/protocol/urls";

export type { DeliveryUrlOptions, PreviewKind };

/**
 * Browser-safe v2 Delivery URL construction. This entry point pulls in no
 * capability crypto, so a client bundle can name a source with its resolver
 * and reference and let the Edge do the rest (ADR 0026).
 */

/** What a v2 Delivery URL names: the Space, the resolver, and the reference segments. */
export interface DeliverySource {
  /** Base URL of the delivery edge. Omit for a relative path. */
  edgeBaseUrl?: string | undefined;
  spaceId: string;
  resolverId: string;
  /** One value per placeholder of the resolver, or a single value for a one-placeholder resolver. */
  reference: string | readonly string[];
}

function segments(reference: string | readonly string[]): readonly string[] {
  return Array.isArray(reference) ? reference : [String(reference)];
}

function withBase(path: string, edgeBaseUrl: string | undefined): string {
  return edgeBaseUrl === undefined ? path : new URL(path, edgeBaseUrl).toString();
}

/**
 * `/v2/{space}/{resolver}/{reference}` with the canonical query. Throws a
 * TypeError for a resolver ID or reference outside the grammar, so a bad key
 * fails at build time rather than as a 404 in production.
 */
export function deliveryUrl(source: DeliverySource, options: DeliveryUrlOptions = {}): string {
  return withBase(
    buildV2DeliveryUrl(source.spaceId, source.resolverId, segments(source.reference), options),
    source.edgeBaseUrl,
  );
}

/** The Source ID a v2 Delivery URL names, as the job and purge endpoints take it. */
export function sourceIdFor(resolverId: string, reference: string | readonly string[]): string {
  if (!isResolverId(resolverId)) {
    throw new TypeError("a resolver ID is a lowercase identifier of at most 64 characters");
  }
  const values = segments(reference);
  if (values.length === 0 || !values.every(isReferenceSegment)) {
    throw new TypeError("a reference segment must match [A-Za-z0-9._-]{1,512} and not be . or ..");
  }
  return resolverSourceId(resolverId, values);
}

const V2_PATH = /^\/v2\/[^/]+\/[^/]+\/./u;
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/** A v2 Delivery URL on the edge, absolute or a path relative to it; nothing for any other value. */
function deliveryUrlOn(value: string, edgeBaseUrl: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value, edgeBaseUrl);
  } catch {
    return undefined;
  }
  return url.origin === new URL(edgeBaseUrl).origin && V2_PATH.test(url.pathname) ? url : undefined;
}

/**
 * True when a value is a v2 Delivery URL on the given edge, absolute or as
 * the relative path `deliveryUrl` returns without an `edgeBaseUrl`, so an
 * image component can tell a Shutter source from a data URL or a third-party
 * one.
 */
export function isDeliveryUrl(value: string, edgeBaseUrl: string): boolean {
  return deliveryUrlOn(value, edgeBaseUrl) !== undefined;
}

/**
 * An Unpic-style transformer: rewrites the width and quality of a v2 Delivery
 * URL and leaves every other URL alone. A relative path comes back relative.
 * A value the caller does not supply keeps what the URL already had, so a
 * preview URL never loses the width it needs. Pass the quality as well, from
 * the Space's Optimization Policy: on a public Space a `w` without `q` is
 * canonicalized with a one-time 308.
 *
 * A private token is bound to one operation, so it is kept only while the
 * operation stays the same. Adding `w` to a Source Delivery URL drops the
 * token, and the Edge refuses the result until the application mints an
 * `image_source` token; mint private URLs with the width they are shown at.
 */
export function transformDeliveryUrl(
  value: string | URL,
  edgeBaseUrl: string,
  options: { width?: number | undefined; quality?: number | undefined },
): string {
  const source = String(value);
  const url = deliveryUrlOn(source, edgeBaseUrl);
  if (url === undefined) return source;
  const preview = url.searchParams.get("preview");
  const token = url.searchParams.get("token");
  const hadWidth = url.searchParams.has("w");
  const width = options.width === undefined ? url.searchParams.get("w") : String(options.width);
  const quality =
    options.quality === undefined ? url.searchParams.get("q") : String(options.quality);
  const query = new URLSearchParams();
  if (preview !== null) query.set("preview", preview);
  if (width !== null) {
    query.set("w", width);
    if (quality !== null) query.set("q", quality);
  }
  if (token !== null && hadWidth === (width !== null)) query.set("token", token);
  url.search = query.toString();
  return SCHEME.test(source) ? url.toString() : `${url.pathname}${url.search}`;
}
