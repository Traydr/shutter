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

export async function sourceFingerprint(spaceId: string, sourceId: string): Promise<string> {
  const framed = frameStrings([PROTOCOL_VERSION, spaceId, sourceId]);
  const digest = await crypto.subtle.digest("SHA-256", framed);
  return encodeBase64Url(new Uint8Array(digest));
}

function inputSegment(input: OptimizationInput): string {
  return input.type === "source" ? "source" : `master-${input.kind}`;
}

export async function buildR2CacheKey(identity: OptimizationCacheIdentity): Promise<string> {
  const fingerprint = await sourceFingerprint(identity.spaceId, identity.sourceId);
  return `cache/v1/${identity.routeClass}/${encodeURIComponent(identity.spaceId)}/${fingerprint}/${inputSegment(identity.input)}/w${identity.width}-q${identity.quality}.webp`;
}

export async function buildR2CachePurgePrefix(
  routeClass: RouteClass,
  spaceId: string,
  sourceId: string,
): Promise<string> {
  const fingerprint = await sourceFingerprint(spaceId, sourceId);
  return `cache/v1/${routeClass}/${encodeURIComponent(spaceId)}/${fingerprint}/`;
}

export async function buildMasterPreviewKey(
  spaceId: string,
  sourceId: string,
  kind: PreviewKind,
): Promise<string> {
  const fingerprint = await sourceFingerprint(spaceId, sourceId);
  return `masters/v1/${encodeURIComponent(spaceId)}/${fingerprint}/${kind}.webp`;
}

export async function buildMasterPurgePrefix(spaceId: string, sourceId: string): Promise<string> {
  const fingerprint = await sourceFingerprint(spaceId, sourceId);
  return `masters/v1/${encodeURIComponent(spaceId)}/${fingerprint}/`;
}

export async function buildSourceCacheTag(spaceId: string, sourceId: string): Promise<string> {
  return `shutter-v1-${await sourceFingerprint(spaceId, sourceId)}`;
}

export async function buildCanonicalCacheUrl(identity: OptimizationCacheIdentity): Promise<string> {
  const key = await buildR2CacheKey(identity);
  return new URL(`/${key}`, "https://cache.shutter.invalid").toString();
}

export async function buildSourceDeliveryCacheUrl(
  identity: SourceDeliveryCacheIdentity,
): Promise<string> {
  const fingerprint = await sourceFingerprint(identity.spaceId, identity.sourceId);
  return new URL(
    `/source/v1/${identity.routeClass}/${encodeURIComponent(identity.spaceId)}/${fingerprint}`,
    "https://cache.shutter.invalid",
  ).toString();
}
