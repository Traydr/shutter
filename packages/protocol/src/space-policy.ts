import { z } from "zod";
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

function identifier(name: string) {
  const error = `${name} must be a lowercase identifier`;
  return z.string({ error }).regex(IDENTIFIER_PATTERN, { error });
}

function unique<Item>(items: readonly Item[], identity: (item: Item) => string): boolean {
  return new Set(items.map(identity)).size === items.length;
}

function parseHttpsOrigin(origin: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return url;
}

const sourceOriginRuleSchema = z
  .strictObject(
    {
      origin: z.string({ error: "allowedSourceOrigins[].origin must be a string" }),
      pathPrefix: z
        .string({ error: "allowedSourceOrigins[].pathPrefix must be an absolute URL path" })
        .optional(),
    },
    { error: "allowedSourceOrigins[] contains missing or unknown fields" },
  )
  .transform((input, context): SourceOriginRule => {
    const url = parseHttpsOrigin(input.origin);
    if (url === undefined) {
      context.addIssue(
        "allowedSourceOrigins[].origin must be an HTTPS origin without credentials, a path, a query, or a fragment",
      );
      return z.NEVER;
    }
    if (input.pathPrefix === undefined) return Object.freeze({ origin: url.origin });
    if (
      !input.pathPrefix.startsWith("/") ||
      input.pathPrefix.includes("?") ||
      input.pathPrefix.includes("#") ||
      input.pathPrefix.includes(",")
    ) {
      context.addIssue("allowedSourceOrigins[].pathPrefix must be an absolute URL path");
      return z.NEVER;
    }
    const pathPrefix = normalizeSourceOriginPathPrefix(input.pathPrefix);
    if (pathPrefix === "/") return Object.freeze({ origin: url.origin });
    return Object.freeze({ origin: url.origin, pathPrefix });
  });

const sourceOriginRulesSchema = z
  .array(sourceOriginRuleSchema, { error: "allowedSourceOrigins must not be empty" })
  .nonempty({ error: "allowedSourceOrigins must not be empty" })
  .refine((rules) => unique(rules, (rule) => `${rule.origin}${rule.pathPrefix ?? "/"}`), {
    error: "allowedSourceOrigins must be unique",
  })
  .readonly();

const resolverSchema = z
  .strictObject(
    {
      id: identifier("resolvers[].id"),
      type: z.string({ error: "resolvers[].type is not supported" }),
      allowedProjectIds: z
        .array(
          z
            .string({ error: "resolvers[].allowedProjectIds[] is not valid" })
            .regex(PROJECT_ID_PATTERN, { error: "resolvers[].allowedProjectIds[] is not valid" }),
          { error: "resolvers[].allowedProjectIds must not be empty" },
        )
        .nonempty({ error: "resolvers[].allowedProjectIds must not be empty" })
        .refine((projectIds) => unique(projectIds, (projectId) => projectId), {
          error: "resolvers[].allowedProjectIds must be unique",
        })
        .readonly(),
    },
    { error: "resolvers[] contains missing or unknown fields" },
  )
  .transform((input, context): SourceResolverPolicy => {
    if (input.type !== "uploadthing") {
      context.addIssue("resolvers[].type is not supported");
      return z.NEVER;
    }
    return Object.freeze({
      id: input.id,
      type: "uploadthing",
      allowedProjectIds: input.allowedProjectIds,
    });
  });

const qualitiesSchema = z
  .array(z.int({ error: "qualities[] must be an integer from 1 to 100" }).min(1).max(100), {
    error: "qualities must not be empty",
  })
  .nonempty({ error: "qualities must not be empty" })
  .refine((qualities) => unique(qualities, String), { error: "qualities must be unique" })
  .readonly();

const spacePolicyCandidateSchema = z.strictObject(
  {
    id: identifier("id"),
    routeClass: z.string({ error: "routeClass must be public or private" }),
    qualities: qualitiesSchema,
    defaultQuality: z.int({ error: "defaultQuality must be one of the permitted qualities" }),
    allowedSourceOrigins: sourceOriginRulesSchema,
    resolvers: z.array(resolverSchema, { error: "resolvers must be an array" }).readonly(),
  },
  { error: "Space policy contains missing or unknown fields" },
);

/**
 * A Space policy before validation: the loosely typed value an operator form,
 * a database row, or an already parsed policy supplies to `parseSpacePolicy`.
 */
export type SpacePolicyInput = z.input<typeof spacePolicyCandidateSchema>;

const spacePolicySchema = spacePolicyCandidateSchema.transform((input, context): SpacePolicy => {
  if (!input.qualities.includes(input.defaultQuality)) {
    context.addIssue("defaultQuality must be one of the permitted qualities");
    return z.NEVER;
  }
  if (!unique(input.resolvers, (resolver) => resolver.id)) {
    context.addIssue("resolver IDs must be unique inside a Space");
    return z.NEVER;
  }
  const common = {
    id: input.id,
    qualities: input.qualities,
    defaultQuality: input.defaultQuality,
    allowedSourceOrigins: input.allowedSourceOrigins,
  };
  if (input.routeClass === "private") {
    if (input.resolvers.length !== 0) {
      context.addIssue("a private Space cannot have a Source Resolver");
      return z.NEVER;
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
      resolvers: input.resolvers,
    }) satisfies PublicSpacePolicy;
  }
  context.addIssue("routeClass must be public or private");
  return z.NEVER;
});

/** The schema for one Space policy; embed it in wire schemas that carry policies. */
export const SPACE_POLICY_SCHEMA = spacePolicySchema;
/** The schema for a Source Origin allowlist; embed it in wire schemas that carry one. */
export const SOURCE_ORIGIN_RULES_SCHEMA = sourceOriginRulesSchema;

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Space policy is invalid";
}

/** Source Origin rules before validation, as `parseSourceOriginRules` accepts them. */
export type SourceOriginRulesInput = z.input<typeof sourceOriginRulesSchema>;

export function parseSourceOriginRules(value: SourceOriginRulesInput): readonly SourceOriginRule[] {
  const result = sourceOriginRulesSchema.safeParse(value);
  if (!result.success) throw new SpacePolicyValidationError(firstIssueMessage(result.error));
  return result.data;
}

export function parseSpacePolicy(value: SpacePolicyInput): SpacePolicy {
  const result = spacePolicySchema.safeParse(value);
  if (!result.success) throw new SpacePolicyValidationError(firstIssueMessage(result.error));
  return result.data;
}
