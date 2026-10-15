import { encodeBase64Url } from "./base64url.js";
import { frameStrings } from "./binary.js";
import { PROTOCOL_VERSION } from "./constants.js";
import type { OptimizationInput, PreviewKind, RouteClass } from "./types.js";

export interface OptimizationCacheIdentity {
  routeClass: RouteClass;
  spaceId: string;
  sourceId: string;
  input: OptimizationInput;
  width: number;
  quality: number;
}

export interface SourceDeliveryCacheIdentity {
  routeClass: RouteClass;
  spaceId: string;
  sourceId: string;
}

/**
 * Every name the Edge stores, caches, tags, and logs one Image Optimization
 * under. All of them derive from one SHA-256 of the Space and Source ID, so a
 * request computes that digest once instead of once per name.
 */
export interface OptimizationCacheNames {
  /** The source fingerprint; also the `sourceHash` of the source's operational events. */
  sourceHash: string;
  cacheTag: string;
  r2Key: string;
  canonicalUrl: string;
}

/** The Source Delivery counterpart of `OptimizationCacheNames`. */
export interface SourceDeliveryCacheNames {
  /** The source fingerprint; also the `sourceHash` of the source's operational events. */
  sourceHash: string;
  cacheTag: string;
  canonicalUrl: string;
}

/** A source whose fingerprint is already known, for deriving further names without a digest. */
export interface FingerprintedSource {
  spaceId: string;
  sourceHash: string;
}

const CACHE_ORIGIN = "https://cache.shutter.invalid";

export async function sourceFingerprint(spaceId: string, sourceId: string): Promise<string> {
  const framed = frameStrings([PROTOCOL_VERSION, spaceId, sourceId]);
  const digest = await crypto.subtle.digest("SHA-256", framed);

  return encodeBase64Url(new Uint8Array(digest));
}

function inputSegment(input: OptimizationInput): string {
  return input.type === "source" ? "source" : `master-${input.kind}`;
}

function cachePrefix(routeClass: RouteClass, source: FingerprintedSource): string {
  return `cache/v1/${routeClass}/${encodeURIComponent(source.spaceId)}/${source.sourceHash}/`;
}

function r2CacheKeyFor(identity: OptimizationCacheIdentity, sourceHash: string): string {
  const prefix = cachePrefix(identity.routeClass, { spaceId: identity.spaceId, sourceHash });

  return `${prefix}${inputSegment(identity.input)}/w${identity.width}-q${identity.quality}.webp`;
}

function masterPrefix(source: FingerprintedSource): string {
  return `masters/v1/${encodeURIComponent(source.spaceId)}/${source.sourceHash}/`;
}

function cacheTagFor(sourceHash: string): string {
  return `shutter-v1-${sourceHash}`;
}

function canonicalUrlFor(r2Key: string): string {
  return new URL(`/${r2Key}`, CACHE_ORIGIN).toString();
}

function sourceDeliveryUrlFor(routeClass: RouteClass, source: FingerprintedSource): string {
  return new URL(
    `/source/v1/${routeClass}/${encodeURIComponent(source.spaceId)}/${source.sourceHash}`,
    CACHE_ORIGIN,
  ).toString();
}

/** The Master Preview key of a source whose fingerprint the caller already holds. */
export function masterPreviewKeyFor(source: FingerprintedSource, kind: PreviewKind): string {
  return `${masterPrefix(source)}${kind}.webp`;
}

export async function optimizationCacheNames(
  identity: OptimizationCacheIdentity,
): Promise<OptimizationCacheNames> {
  const sourceHash = await sourceFingerprint(identity.spaceId, identity.sourceId);
  const r2Key = r2CacheKeyFor(identity, sourceHash);

  return {
    sourceHash,
    cacheTag: cacheTagFor(sourceHash),
    r2Key,
    canonicalUrl: canonicalUrlFor(r2Key),
  };
}

export async function sourceDeliveryCacheNames(
  identity: SourceDeliveryCacheIdentity,
): Promise<SourceDeliveryCacheNames> {
  const sourceHash = await sourceFingerprint(identity.spaceId, identity.sourceId);

  return {
    sourceHash,
    cacheTag: cacheTagFor(sourceHash),
    canonicalUrl: sourceDeliveryUrlFor(identity.routeClass, {
      spaceId: identity.spaceId,
      sourceHash,
    }),
  };
}

export async function buildR2CacheKey(identity: OptimizationCacheIdentity): Promise<string> {
  return r2CacheKeyFor(identity, await sourceFingerprint(identity.spaceId, identity.sourceId));
}

export async function buildR2CachePurgePrefix(
  routeClass: RouteClass,
  spaceId: string,
  sourceId: string,
): Promise<string> {
  return cachePrefix(routeClass, {
    spaceId,
    sourceHash: await sourceFingerprint(spaceId, sourceId),
  });
}

export async function buildMasterPreviewKey(
  spaceId: string,
  sourceId: string,
  kind: PreviewKind,
): Promise<string> {
  return masterPreviewKeyFor(
    { spaceId, sourceHash: await sourceFingerprint(spaceId, sourceId) },
    kind,
  );
}

export async function buildMasterPurgePrefix(spaceId: string, sourceId: string): Promise<string> {
  return masterPrefix({ spaceId, sourceHash: await sourceFingerprint(spaceId, sourceId) });
}

export async function buildSourceCacheTag(spaceId: string, sourceId: string): Promise<string> {
  return cacheTagFor(await sourceFingerprint(spaceId, sourceId));
}

export async function buildCanonicalCacheUrl(identity: OptimizationCacheIdentity): Promise<string> {
  return canonicalUrlFor(await buildR2CacheKey(identity));
}

export async function buildSourceDeliveryCacheUrl(
  identity: SourceDeliveryCacheIdentity,
): Promise<string> {
  return (await sourceDeliveryCacheNames(identity)).canonicalUrl;
}
