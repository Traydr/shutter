import { z } from "zod";
import type { JsonObject } from "./json.js";
import { normalizeSourceOriginPathPrefix } from "./source-locator.js";
import {
  isHostLabel,
  isPlaceholderName,
  isReferenceSegment,
  parseKeyTemplate,
  parseUrlTemplate,
  ResolverTemplateError,
  validateResolverOrigins,
} from "./source-resolver.js";
import type {
  PrivateSpacePolicy,
  PublicSpacePolicy,
  ResolverPlaceholderPolicy,
  S3ResolverPolicy,
  SourceOriginRule,
  SourceResolverPolicy,
  SpacePolicy,
  TemplateResolverPolicy,
  UploadThingResolverPolicy,
} from "./types.js";

export { normalizeSourceOriginPathPrefix };

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export class SpacePolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpacePolicyValidationError";
  }
}

const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const IP_ADDRESS_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** The general-purpose S3 bucket naming rules: 3 to 63 characters, no `..`, and not an IP address. */
export function isBucketName(value: string): boolean {
  return (
    BUCKET_NAME_PATTERN.test(value) && !value.includes("..") && !IP_ADDRESS_PATTERN.test(value)
  );
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

const uploadThingResolverSchema = z
  .strictObject(
    {
      id: identifier("resolvers[].id"),
      type: z.literal("uploadthing"),
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
  .transform(
    (input): UploadThingResolverPolicy =>
      Object.freeze({
        id: input.id,
        type: "uploadthing",
        allowedProjectIds: input.allowedProjectIds,
      }),
  );

const allowedValuesSchema = z
  .array(z.string({ error: "resolvers[].placeholders[].allowed[] must be a string" }), {
    error: "resolvers[].placeholders[].allowed must be an array",
  })
  .nonempty({ error: "resolvers[].placeholders[].allowed must not be empty" })
  .refine((values) => unique(values, (value) => value), {
    error: "resolvers[].placeholders[].allowed must be unique",
  })
  .readonly();

const placeholderPolicySchema = z
  .strictObject(
    { allowed: allowedValuesSchema.optional() },
    { error: "resolvers[].placeholders[] contains unknown fields" },
  )
  .transform((input): ResolverPlaceholderPolicy => {
    const policy: ResolverPlaceholderPolicy = {};
    if (input.allowed !== undefined) policy.allowed = input.allowed;
    return Object.freeze(policy);
  });

const templateResolverSchema = z
  .strictObject(
    {
      id: identifier("resolvers[].id"),
      type: z.literal("template"),
      url: z.string({ error: "resolvers[].url must be a string" }),
      placeholders: z.record(z.string(), placeholderPolicySchema, {
        error: "resolvers[].placeholders must be an object",
      }),
    },
    { error: "resolvers[] contains missing or unknown fields" },
  )
  .transform((input, context): TemplateResolverPolicy => {
    let template: ReturnType<typeof parseUrlTemplate>;
    try {
      template = parseUrlTemplate(input.url);
    } catch (error) {
      context.addIssue(
        error instanceof ResolverTemplateError
          ? `resolvers[].url: ${error.message}`
          : "resolvers[].url is not a valid template",
      );
      return z.NEVER;
    }
    const names = Object.keys(input.placeholders);
    if (
      names.length !== template.placeholders.length ||
      names.some((name) => !template.placeholders.includes(name))
    ) {
      context.addIssue("resolvers[].placeholders must name exactly the placeholders in the url");
      return z.NEVER;
    }
    const placeholders: Record<string, ResolverPlaceholderPolicy> = {};
    for (const name of template.placeholders) {
      const placeholder = input.placeholders[name];
      if (placeholder === undefined) {
        context.addIssue("resolvers[].placeholders must name exactly the placeholders in the url");
        return z.NEVER;
      }
      placeholders[name] = placeholder;
      const allowed = placeholder.allowed;
      if (name === template.hostPlaceholder) {
        if (allowed === undefined) {
          context.addIssue("a hostname placeholder must list its allowed values");
          return z.NEVER;
        }
        if (!allowed.every(isHostLabel)) {
          context.addIssue("a hostname placeholder value must be a hostname label");
          return z.NEVER;
        }
      } else if (allowed !== undefined && !allowed.every(isReferenceSegment)) {
        context.addIssue("a placeholder value must be a reference segment");
        return z.NEVER;
      }
    }
    return Object.freeze({
      id: input.id,
      type: "template",
      url: input.url,
      placeholders: Object.freeze(placeholders),
    });
  });

const s3ResolverSchema = z
  .strictObject(
    {
      id: identifier("resolvers[].id"),
      type: z.literal("s3"),
      endpoint: z.string({ error: "resolvers[].endpoint must be a string" }),
      region: z
        .string({ error: "resolvers[].region must be a non-empty string" })
        .min(1, { error: "resolvers[].region must be a non-empty string" })
        .max(64, { error: "resolvers[].region must be a non-empty string" }),
      bucket: z
        .string({ error: "resolvers[].bucket must be an S3 bucket name" })
        .refine(isBucketName, { error: "resolvers[].bucket must be an S3 bucket name" }),
      pathStyle: z.boolean({ error: "resolvers[].pathStyle must be a boolean" }),
      keyTemplate: z.string({ error: "resolvers[].keyTemplate must be a string" }),
    },
    { error: "resolvers[] contains missing or unknown fields" },
  )
  .transform((input, context): S3ResolverPolicy => {
    const endpoint = parseHttpsOrigin(input.endpoint);
    if (endpoint === undefined) {
      context.addIssue("resolvers[].endpoint must be an HTTPS origin without a path");
      return z.NEVER;
    }
    try {
      parseKeyTemplate(input.keyTemplate);
    } catch (error) {
      context.addIssue(
        error instanceof ResolverTemplateError
          ? `resolvers[].keyTemplate: ${error.message}`
          : "resolvers[].keyTemplate is not a valid template",
      );
      return z.NEVER;
    }
    return Object.freeze({
      id: input.id,
      type: "s3",
      endpoint: endpoint.origin,
      region: input.region,
      bucket: input.bucket,
      pathStyle: input.pathStyle,
      keyTemplate: input.keyTemplate,
    });
  });

const resolverSchema = z.discriminatedUnion(
  "type",
  [uploadThingResolverSchema, templateResolverSchema, s3ResolverSchema],
  { error: "resolvers[].type is not supported" },
);

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

function resolverOriginIssue(
  resolver: SourceResolverPolicy,
  rules: readonly SourceOriginRule[],
): string | undefined {
  try {
    validateResolverOrigins(resolver, rules);
    return undefined;
  } catch {
    return `resolver ${resolver.id} can produce a location outside allowedSourceOrigins`;
  }
}

const spacePolicySchema = spacePolicyCandidateSchema.transform((input, context): SpacePolicy => {
  if (!input.qualities.includes(input.defaultQuality)) {
    context.addIssue("defaultQuality must be one of the permitted qualities");
    return z.NEVER;
  }
  if (!unique(input.resolvers, (resolver) => resolver.id)) {
    context.addIssue("resolver IDs must be unique inside a Space");
    return z.NEVER;
  }
  for (const resolver of input.resolvers) {
    // The retired UploadThing kind predates the allowlist rule; migration 0003
    // adds the matching origins when it rewrites those rows into templates.
    if (resolver.type === "uploadthing") continue;
    const issue = resolverOriginIssue(resolver, input.allowedSourceOrigins);
    if (issue !== undefined) {
      context.addIssue(issue);
      return z.NEVER;
    }
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
/** The schema for one Source Resolver; the admin editor parses a single resolver with it. */
export const SOURCE_RESOLVER_SCHEMA = resolverSchema;

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

/**
 * Parses a policy from typed input or from a JSON document such as a
 * database row set; both are boundaries the schema owns.
 */
export function parseSpacePolicy(value: SpacePolicyInput | JsonObject): SpacePolicy {
  const result = spacePolicySchema.safeParse(value);
  if (!result.success) throw new SpacePolicyValidationError(firstIssueMessage(result.error));
  return result.data;
}

/** Whether `isPlaceholderName` accepts the name; exported for the admin editor's field checks. */
export { isPlaceholderName };
