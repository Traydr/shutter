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
