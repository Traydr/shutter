import { isReferenceSegment, isResolverId, resolverSourceId } from "./source-resolver.js";
import type { PreviewKind } from "./types.js";

export type { PreviewKind };
/**
 * This module is also the package's `./urls` entry: URL construction with no
 * capability crypto behind it, so a browser bundle can import it alone.
 */
export { isReferenceSegment, isResolverId, resolverSourceId };

interface OptimizationParameters {
  width: number;
  quality: number;
}

function segment(value: string): string {
  if (value.length === 0) throw new TypeError("path segments cannot be empty");
  return encodeURIComponent(value);
}

function optimizationQuery({ width, quality }: OptimizationParameters): string {
  return `w=${width}&q=${quality}`;
}

export function buildPublicLocatedSourceUrl(
  spaceId: string,
  sourceId: string,
  capability: string,
  parameters: OptimizationParameters,
): string {
  return `/v1/public/${segment(spaceId)}/located/${segment(sourceId)}/${segment(capability)}?${optimizationQuery(parameters)}`;
}

export function buildPublicLocatedDeliveryUrl(
  spaceId: string,
  sourceId: string,
  capability: string,
): string {
  return `/v1/public/${segment(spaceId)}/delivery/located/${segment(sourceId)}/${segment(capability)}`;
}

export function buildPrivateDeliveryUrl(spaceId: string, capability: string): string {
  return `/v1/private/${segment(spaceId)}/delivery/${segment(capability)}`;
}

export function buildPublicMasterUrl(
  spaceId: string,
  kind: PreviewKind,
  sourceId: string,
  parameters: OptimizationParameters,
): string {
  return `/v1/public/${segment(spaceId)}/master/${kind}/${segment(sourceId)}?${optimizationQuery(parameters)}`;
}

export function buildPrivateSourceUrl(
  spaceId: string,
  capability: string,
  parameters: OptimizationParameters,
): string {
  return `/v1/private/${segment(spaceId)}/source/${segment(capability)}?${optimizationQuery(parameters)}`;
}

export function buildPrivateMasterUrl(
  spaceId: string,
  capability: string,
  parameters: OptimizationParameters,
): string {
  return `/v1/private/${segment(spaceId)}/master/${segment(capability)}?${optimizationQuery(parameters)}`;
}

export function buildPreviewJobUrl(spaceId: string, sourceId: string, kind: PreviewKind): string {
  return `/v1/spaces/${segment(spaceId)}/sources/${segment(sourceId)}/previews/${kind}`;
}

export function buildSourcePurgeUrl(spaceId: string, sourceId: string): string {
  return `/v1/spaces/${segment(spaceId)}/sources/${segment(sourceId)}/purge`;
}

// v2

/** How a v2 Delivery URL should look beyond its path: which operation, and for a private Space, the token. */
export interface DeliveryUrlOptions {
  width?: number | undefined;
  quality?: number | undefined;
  preview?: PreviewKind | undefined;
  token?: string | undefined;
}

/**
 * `/v2/{space}/{resolver}/{reference}` with the canonical query order
 * (`preview`, `w`, `q`, `token`). `quality` and `preview` need `width`; the
 * builder refuses a combination the Edge would answer 400 to.
 */
export function buildV2DeliveryUrl(
  spaceId: string,
  resolverId: string,
  reference: readonly string[],
  options: DeliveryUrlOptions = {},
): string {
  if (!isResolverId(resolverId)) {
    throw new TypeError("a resolver ID is a lowercase identifier of at most 64 characters");
  }
  if (reference.length === 0) throw new TypeError("a reference needs at least one segment");
  if (!reference.every(isReferenceSegment)) {
    throw new TypeError("a reference segment must match [A-Za-z0-9._-]{1,512} and not be . or ..");
  }
  if (
    options.width === undefined &&
    (options.quality !== undefined || options.preview !== undefined)
  ) {
    throw new TypeError("quality and preview require width");
  }
  const query = new URLSearchParams();
  if (options.preview !== undefined) query.set("preview", options.preview);
  if (options.width !== undefined) query.set("w", String(options.width));
  if (options.quality !== undefined) query.set("q", String(options.quality));
  if (options.token !== undefined) query.set("token", options.token);
  const path = `/v2/${segment(spaceId)}/${segment(resolverId)}/${reference.map(segment).join("/")}`;
  const search = query.toString();
  return search.length === 0 ? path : `${path}?${search}`;
}

export function buildV2PreviewJobUrl(spaceId: string, sourceId: string, kind: PreviewKind): string {
  return `/v2/spaces/${segment(spaceId)}/sources/${segment(sourceId)}/previews/${kind}`;
}

export function buildV2SourcePurgeUrl(spaceId: string, sourceId: string): string {
  return `/v2/spaces/${segment(spaceId)}/sources/${segment(sourceId)}/purge`;
}
