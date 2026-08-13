import type {
  PrivateSpacePolicy,
  PublicSpacePolicy,
  SourceOriginRule,
  SourceResolverPolicy,
  SpacePolicy,
} from "./types.js";

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export class SpacePolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpacePolicyValidationError";
  }
}

/**
 * The one canonical Source Origin path-prefix normalization. The parser, the
 * Postgres storage layer, and locator enforcement must all agree on this form
 * or the Source Locator allowlist breaks: "/" is the canonical root prefix,
 * every other prefix keeps its leading "/" and loses trailing "/" runs.
 */
export function normalizeSourceOriginPathPrefix(pathPrefix: string | undefined): string {
  if (pathPrefix === undefined) return "/";
  const rooted = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
  const trimmed = rooted.replace(/\/+$/u, "");
  return trimmed === "" ? "/" : trimmed;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SpacePolicyValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new SpacePolicyValidationError(`${name} contains missing or unknown fields`);
  }
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new SpacePolicyValidationError(`${name} must be a lowercase identifier`);
  }
  return value;
}

function sourceOrigin(value: unknown, index: number): SourceOriginRule {
  const name = `allowedSourceOrigins[${index}]`;
  const input = record(value, name);
  const keys = Object.keys(input);
  if (!keys.includes("origin") || keys.some((key) => key !== "origin" && key !== "pathPrefix")) {
    throw new SpacePolicyValidationError(`${name} contains missing or unknown fields`);
  }
  if (typeof input.origin !== "string") {
    throw new SpacePolicyValidationError(`${name}.origin must be a string`);
  }
  let url: URL;
  try {
    url = new URL(input.origin);
  } catch {
    throw new SpacePolicyValidationError(`${name}.origin must be an absolute URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new SpacePolicyValidationError(
      `${name}.origin must be an HTTPS origin without credentials, a path, a query, or a fragment`,
    );
  }
  if (input.pathPrefix === undefined) return Object.freeze({ origin: url.origin });
  if (
    typeof input.pathPrefix !== "string" ||
    !input.pathPrefix.startsWith("/") ||
    input.pathPrefix.includes("?") ||
    input.pathPrefix.includes("#") ||
    input.pathPrefix.includes(",")
  ) {
    throw new SpacePolicyValidationError(`${name}.pathPrefix must be an absolute URL path`);
  }
  const pathPrefix = normalizeSourceOriginPathPrefix(input.pathPrefix);
  if (pathPrefix === "/") return Object.freeze({ origin: url.origin });
  return Object.freeze({ origin: url.origin, pathPrefix });
}

export function parseSourceOriginRules(value: unknown): readonly SourceOriginRule[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SpacePolicyValidationError("allowedSourceOrigins must not be empty");
  }
  const parsed = Object.freeze(value.map(sourceOrigin));
  const identities = parsed.map((rule) => `${rule.origin}${rule.pathPrefix ?? "/"}`);
  if (new Set(identities).size !== identities.length) {
    throw new SpacePolicyValidationError("allowedSourceOrigins must be unique");
  }
  return parsed;
}

function resolver(value: unknown, index: number): SourceResolverPolicy {
  const name = `resolvers[${index}]`;
  const input = record(value, name);
  exactKeys(input, ["id", "type", "allowedProjectIds"], name);
  const id = identifier(input.id, `${name}.id`);
  if (input.type !== "uploadthing") {
    throw new SpacePolicyValidationError(`${name}.type is not supported`);
  }
  if (!Array.isArray(input.allowedProjectIds) || input.allowedProjectIds.length === 0) {
    throw new SpacePolicyValidationError(`${name}.allowedProjectIds must not be empty`);
  }
  const allowedProjectIds = input.allowedProjectIds.map((projectId, projectIndex) => {
    if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new SpacePolicyValidationError(
        `${name}.allowedProjectIds[${projectIndex}] is not valid`,
      );
    }
    return projectId;
  });
  if (new Set(allowedProjectIds).size !== allowedProjectIds.length) {
    throw new SpacePolicyValidationError(`${name}.allowedProjectIds must be unique`);
  }
  return Object.freeze({
    id,
    type: "uploadthing",
    allowedProjectIds: Object.freeze(allowedProjectIds),
  });
}

function qualities(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SpacePolicyValidationError("qualities must not be empty");
  }
  const parsed = value.map((quality, index) => {
    if (!Number.isSafeInteger(quality) || (quality as number) < 1 || (quality as number) > 100) {
      throw new SpacePolicyValidationError(`qualities[${index}] must be an integer from 1 to 100`);
    }
    return quality as number;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new SpacePolicyValidationError("qualities must be unique");
  }
  return Object.freeze(parsed);
}

export function parseSpacePolicy(value: unknown): SpacePolicy {
  const input = record(value, "Space policy");
  exactKeys(
    input,
    ["id", "routeClass", "qualities", "defaultQuality", "allowedSourceOrigins", "resolvers"],
    "Space policy",
  );
  const id = identifier(input.id, "id");
  const parsedQualities = qualities(input.qualities);
  if (
    !Number.isSafeInteger(input.defaultQuality) ||
    !parsedQualities.includes(input.defaultQuality as number)
  ) {
    throw new SpacePolicyValidationError("defaultQuality must be one of the permitted qualities");
  }
  const allowedSourceOrigins = parseSourceOriginRules(input.allowedSourceOrigins);
  if (!Array.isArray(input.resolvers)) {
    throw new SpacePolicyValidationError("resolvers must be an array");
  }
  const resolvers = Object.freeze(input.resolvers.map(resolver));
  if (new Set(resolvers.map((entry) => entry.id)).size !== resolvers.length) {
    throw new SpacePolicyValidationError("resolver IDs must be unique inside a Space");
  }
  const common = {
    id,
    qualities: parsedQualities,
    defaultQuality: input.defaultQuality as number,
    allowedSourceOrigins,
  };
  if (input.routeClass === "private") {
    if (resolvers.length !== 0) {
      throw new SpacePolicyValidationError("a private Space cannot have a Source Resolver");
    }
    return Object.freeze({
      ...common,
      routeClass: "private",
      resolvers: Object.freeze([] as const),
    }) satisfies PrivateSpacePolicy;
  }
  if (input.routeClass === "public") {
    return Object.freeze({
      ...common,
      routeClass: "public",
      resolvers,
    }) satisfies PublicSpacePolicy;
  }
  throw new SpacePolicyValidationError("routeClass must be public or private");
}
