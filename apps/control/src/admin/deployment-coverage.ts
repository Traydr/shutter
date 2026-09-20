import { normalizeSourceOriginPathPrefix, type SourceOriginRule } from "@shutter/protocol";
import type { SpaceRecord } from "../spaces/registry.js";

export interface DeploymentCoverage {
  derivedValue: string;
  uncovered: readonly string[];
  /** The Media Store prefix counted in both fields, when the deployment has one. */
  mediaStoreSource?: string;
}

/** The `origin[/path-prefix]` form of one allowed-source rule, as imgproxy and the admin pages show it. */
export function sourceOriginPrefix(rule: SourceOriginRule): string {
  const prefix = normalizeSourceOriginPathPrefix(rule.pathPrefix);
  return `${rule.origin}${prefix === "/" ? "" : prefix}`;
}

function normalizedPrefix(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") return undefined;
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return undefined;
  }
}

function covers(configured: string, required: string): boolean {
  return required === configured || required.startsWith(`${configured}/`);
}

/**
 * What imgproxy must allow: every active Space origin and, when given, the
 * Media Store prefix Master Previews are read from. Each derived entry ends in
 * a slash because imgproxy matches plain string prefixes; without it
 * `https://a.example` would also admit `https://a.example.evil.test`.
 */
export function deploymentCoverage(
  spaces: readonly SpaceRecord[],
  configuredValue: string | undefined,
  mediaStoreSource?: string,
): DeploymentCoverage {
  const mediaStore =
    mediaStoreSource === undefined ? undefined : normalizedPrefix(mediaStoreSource);
  const required = [
    ...new Set([
      ...spaces
        .filter((space) => space.status === "active")
        .flatMap((space) => space.policy.allowedSourceOrigins.map(sourceOriginPrefix)),
      ...(mediaStore === undefined ? [] : [mediaStore]),
    ]),
  ].sort();
  const configured = (configuredValue ?? "")
    .split(",")
    .map(normalizedPrefix)
    .filter((value): value is string => value !== undefined);
  const coverage: DeploymentCoverage = {
    derivedValue: required.map((prefix) => `${prefix}/`).join(","),
    uncovered: required.filter(
      (requiredPrefix) => !configured.some((candidate) => covers(candidate, requiredPrefix)),
    ),
  };
  if (mediaStore !== undefined) coverage.mediaStoreSource = mediaStore;
  return coverage;
}
