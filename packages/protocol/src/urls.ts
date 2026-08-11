import type { RenditionKind } from "./types.js";

interface RenditionParameters {
  width: number;
  quality: number;
}

function segment(value: string): string {
  if (value.length === 0) throw new TypeError("path segments cannot be empty");
  return encodeURIComponent(value);
}

function renditionQuery({ width, quality }: RenditionParameters): string {
  return `w=${width}&q=${quality}`;
}

export function buildPublicResolverUrl(
  spaceId: string,
  resolverId: string,
  sourceRef: string,
  parameters: RenditionParameters,
): string {
  return `/v1/public/${segment(spaceId)}/resolver/${segment(resolverId)}/${segment(sourceRef)}?${renditionQuery(parameters)}`;
}

export function buildPublicLocatedSourceUrl(
  spaceId: string,
  sourceId: string,
  capability: string,
  parameters: RenditionParameters,
): string {
  return `/v1/public/${segment(spaceId)}/located/${segment(sourceId)}/${segment(capability)}?${renditionQuery(parameters)}`;
}

export function buildPublicResolverDeliveryUrl(
  spaceId: string,
  resolverId: string,
  sourceRef: string,
): string {
  return `/v1/public/${segment(spaceId)}/delivery/resolver/${segment(resolverId)}/${segment(sourceRef)}`;
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
  kind: RenditionKind,
  sourceId: string,
  parameters: RenditionParameters,
): string {
  return `/v1/public/${segment(spaceId)}/master/${kind}/${segment(sourceId)}?${renditionQuery(parameters)}`;
}

export function buildPrivateSourceUrl(
  spaceId: string,
  capability: string,
  parameters: RenditionParameters,
): string {
  return `/v1/private/${segment(spaceId)}/source/${segment(capability)}?${renditionQuery(parameters)}`;
}

export function buildPrivateMasterUrl(
  spaceId: string,
  capability: string,
  parameters: RenditionParameters,
): string {
  return `/v1/private/${segment(spaceId)}/master/${segment(capability)}?${renditionQuery(parameters)}`;
}

export function buildPreviewJobUrl(spaceId: string, sourceId: string, kind: RenditionKind): string {
  return `/v1/spaces/${segment(spaceId)}/sources/${segment(sourceId)}/previews/${kind}`;
}

export function buildSourcePurgeUrl(spaceId: string, sourceId: string): string {
  return `/v1/spaces/${segment(spaceId)}/sources/${segment(sourceId)}/purge`;
}
