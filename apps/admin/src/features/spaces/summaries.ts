import type { AdminOverview } from "@shutter/admin-api";
import type { SourceOriginRule, SourceResolverPolicy } from "@shutter/protocol";

/** The `origin[/path-prefix]` form of one allowed-source rule, as imgproxy and the pages show it. */
export function originPrefix(rule: SourceOriginRule): string {
  const prefix = rule.pathPrefix ?? "";
  return `${rule.origin}${prefix === "/" ? "" : prefix}`;
}

export function withoutScheme(prefix: string): string {
  return prefix.replace(/^https:\/\//u, "");
}

/** One resolver in a sentence: its kind and the one field that says where it points. */
export function resolverSummary(resolver: SourceResolverPolicy): string {
  switch (resolver.type) {
    case "uploadthing":
      return `uploadthing (retired) · ${resolver.allowedProjectIds.join(", ")}`;
    case "template":
      return resolver.url;
    case "s3":
      return `${
        resolver.pathStyle
          ? `${resolver.endpoint}/${resolver.bucket}`
          : `${resolver.bucket}.${new URL(resolver.endpoint).host}`
      } · ${resolver.keyTemplate}`;
  }
}

export type EdgeState =
  | { kind: "unreported" }
  | { kind: "in-sync"; generation: number; refreshedAt: string }
  | { kind: "behind"; generation: number; refreshedAt: string; lag: number };

export function edgeState(overview: Pick<AdminOverview, "generation" | "edgeRefresh">): EdgeState {
  const refresh = overview.edgeRefresh;
  if (refresh === undefined) return { kind: "unreported" };
  const lag = overview.generation - refresh.generation;
  return lag <= 0
    ? { kind: "in-sync", generation: refresh.generation, refreshedAt: refresh.refreshedAt }
    : { kind: "behind", generation: refresh.generation, refreshedAt: refresh.refreshedAt, lag };
}
