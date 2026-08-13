import { normalizeSourceOriginPathPrefix } from "@shutter/protocol";
import type { SpaceRecord } from "../spaces/registry.js";

export interface DeploymentCoverage {
  derivedValue: string;
  uncovered: readonly string[];
}

function rulePrefix(origin: string, pathPrefix: string | undefined): string {
  const prefix = normalizeSourceOriginPathPrefix(pathPrefix);
  return `${origin}${prefix === "/" ? "" : prefix}`;
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

export function deploymentCoverage(
  spaces: readonly SpaceRecord[],
  configuredValue: string | undefined,
): DeploymentCoverage {
  const required = [
    ...new Set(
      spaces
        .filter((space) => space.status === "active")
        .flatMap((space) =>
          space.policy.allowedSourceOrigins.map((rule) => rulePrefix(rule.origin, rule.pathPrefix)),
        ),
    ),
  ].sort();
  const configured = (configuredValue ?? "")
    .split(",")
    .map(normalizedPrefix)
    .filter((value): value is string => value !== undefined);
  return {
    derivedValue: required.join(","),
    uncovered: required.filter(
      (requiredPrefix) => !configured.some((candidate) => covers(candidate, requiredPrefix)),
    ),
  };
}
