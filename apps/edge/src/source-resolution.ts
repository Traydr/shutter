/**
 * Extracts the percent-encoded Source reference that follows the
 * `/resolver/:resolverId/` marker. Both the derivative and the delivery route
 * share this one copy so a malformed escape or an unencoded `/` answers 404
 * identically on each.
 */
export function resolverSourceRef(requestUrl: string, resolverId: string): string | undefined {
  const pathname = new URL(requestUrl).pathname;
  const marker = `/resolver/${encodeURIComponent(resolverId)}/`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const encodedSourceRef = pathname.slice(markerIndex + marker.length);
  if (encodedSourceRef.includes("/")) return undefined;
  try {
    return decodeURIComponent(encodedSourceRef);
  } catch {
    return undefined;
  }
}

export function resolveUploadThingSource(
  sourceRef: string,
  allowedProjectIds: readonly string[],
): { sourceId: string; sourceUrl: string } | undefined {
  const separator = sourceRef.indexOf("/");
  if (
    separator <= 0 ||
    separator !== sourceRef.lastIndexOf("/") ||
    separator === sourceRef.length - 1
  ) {
    return undefined;
  }
  const projectId = sourceRef.slice(0, separator);
  const fileKey = sourceRef.slice(separator + 1);
  if (
    !allowedProjectIds.includes(projectId) ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(projectId) ||
    !/^[A-Za-z0-9_-]{1,512}$/u.test(fileKey)
  ) {
    return undefined;
  }
  return {
    sourceId: sourceRef,
    sourceUrl: `https://${projectId}.ufs.sh/f/${encodeURIComponent(fileKey)}`,
  };
}
