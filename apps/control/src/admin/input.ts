import {
  parseSpacePolicy,
  type SourceOriginRule,
  type SourceResolverPolicy,
  type SpacePolicy,
} from "@shutter/protocol";
import type { SpacePolicyUpdate } from "../spaces/registry.js";

export class AdminInputError extends Error {
  constructor() {
    super("The submitted values are not valid.");
    this.name = "AdminInputError";
  }
}

function required(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdminInputError();
  }
  return value.trim();
}

function qualities(form: FormData): readonly number[] {
  return required(form, "qualities")
    .split(",")
    .map((value) => Number(value.trim()));
}

function origins(form: FormData): readonly SourceOriginRule[] {
  return required(form, "allowedSourceOrigins")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const url = new URL(line);
      if (url.search !== "" || url.hash !== "") throw new AdminInputError();
      const pathPrefix = url.pathname === "/" ? undefined : url.pathname.replace(/\/+$/u, "");
      return { origin: url.origin, ...(pathPrefix === undefined ? {} : { pathPrefix }) };
    });
}

function resolvers(form: FormData): readonly SourceResolverPolicy[] {
  const input = form.get("resolvers");
  if (typeof input !== "string" || input.trim().length === 0) return [];
  return input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator < 1) throw new AdminInputError();
      return {
        id: line.slice(0, separator).trim(),
        type: "uploadthing" as const,
        allowedProjectIds: line
          .slice(separator + 1)
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      };
    });
}

function mutablePolicy(form: FormData): SpacePolicyUpdate {
  return {
    qualities: qualities(form),
    defaultQuality: Number(required(form, "defaultQuality")),
    allowedSourceOrigins: origins(form),
    resolvers: resolvers(form),
  };
}

export function parseCreateSpaceForm(form: FormData): SpacePolicy {
  try {
    return parseSpacePolicy({
      id: required(form, "spaceId"),
      routeClass: required(form, "routeClass"),
      ...mutablePolicy(form),
    });
  } catch {
    throw new AdminInputError();
  }
}

export function parseEditSpaceForm(form: FormData): SpacePolicyUpdate {
  try {
    return mutablePolicy(form);
  } catch {
    throw new AdminInputError();
  }
}
