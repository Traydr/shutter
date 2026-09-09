import {
  isPlaceholderName,
  normalizeSourceOriginPathPrefix,
  parseSpacePolicy,
  parseUrlTemplate,
  type ResolverPlaceholderPolicy,
  SOURCE_RESOLVER_SCHEMA,
  type SourceOriginRule,
  type SourceResolverPolicy,
  type SpacePolicy,
  SpacePolicyValidationError,
  type TemplateResolverPolicy,
} from "@shutter/protocol";
import { z } from "zod";
import type { ResolverCredentialInput, SpacePolicyUpdate } from "../spaces/registry.js";

export class AdminInputError extends Error {
  constructor() {
    super("The submitted values are not valid.");
    this.name = "AdminInputError";
  }
}

const textField = z.string();

/** The text value of one form field, or undefined when it is absent or a file part. */
export function formText(form: FormData, name: string): string | undefined {
  const value = textField.safeParse(form.get(name));
  return value.success ? value.data : undefined;
}

function required(form: FormData, name: string): string {
  const value = formText(form, name)?.trim();
  if (value === undefined || value.length === 0) throw new AdminInputError();
  return value;
}

function optional(form: FormData, name: string): string | undefined {
  const value = formText(form, name)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
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
      const pathPrefix = normalizeSourceOriginPathPrefix(url.pathname);
      const rule: SourceOriginRule = { origin: url.origin };
      if (pathPrefix !== "/") rule.pathPrefix = pathPrefix;
      return rule;
    });
}

/**
 * The policy fields the Space forms edit. Resolvers are not among them: they
 * have their own editor, and a policy save carries the current list through.
 */
function mutablePolicy(form: FormData): Omit<SpacePolicyUpdate, "resolvers"> {
  return {
    qualities: qualities(form),
    defaultQuality: Number(required(form, "defaultQuality")),
    allowedSourceOrigins: origins(form),
  };
}

export function parseCreateSpaceForm(form: FormData): SpacePolicy {
  try {
    return parseSpacePolicy({
      id: required(form, "spaceId"),
      routeClass: required(form, "routeClass"),
      ...mutablePolicy(form),
      resolvers: [],
    });
  } catch {
    throw new AdminInputError();
  }
}

export function parseEditSpaceForm(form: FormData): Omit<SpacePolicyUpdate, "resolvers"> {
  try {
    return mutablePolicy(form);
  } catch {
    throw new AdminInputError();
  }
}

export type ResolverKind = "template" | "s3";

export function resolverKind(value: string | undefined): ResolverKind | undefined {
  return value === "template" || value === "s3" ? value : undefined;
}

export interface ResolverForm {
  resolver: SourceResolverPolicy;
  /** Present when the form supplied a credential; absent keeps the stored one. */
  credential?: ResolverCredentialInput;
}

/**
 * The `allowed` textarea: one `name=value,value` line per placeholder that
 * restricts its values. A line naming a placeholder the URL does not have is
 * rejected by the resolver schema, not here.
 */
function allowedValues(form: FormData): TemplateResolverPolicy["placeholders"] {
  const placeholders: Record<string, ResolverPlaceholderPolicy> = {};
  for (const line of (formText(form, "allowed") ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) throw new AdminInputError();
    const name = trimmed.slice(0, separator).trim();
    if (!isPlaceholderName(name)) throw new AdminInputError();
    const values = trimmed
      .slice(separator + 1)
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    placeholders[name] = values.length === 0 ? {} : { allowed: values };
  }
  return placeholders;
}

/** Parses one resolver's form into its policy through the shared schema, naming the first issue. */
export function parseResolverForm(form: FormData, resolverId: string): ResolverForm {
  const kind = resolverKind(formText(form, "kind"));
  if (kind === undefined) throw new AdminInputError();
  if (kind === "template") {
    const url = required(form, "url");
    let placeholderNames: readonly string[];
    try {
      placeholderNames = parseUrlTemplate(url).placeholders;
    } catch (error) {
      throw new SpacePolicyValidationError(
        error instanceof Error ? `resolvers[].url: ${error.message}` : "the template is invalid",
      );
    }
    const restricted = allowedValues(form);
    const placeholders: Record<string, ResolverPlaceholderPolicy> = {};
    for (const name of placeholderNames) placeholders[name] = restricted[name] ?? {};
    for (const name of Object.keys(restricted)) placeholders[name] ??= restricted[name] ?? {};
    return { resolver: parseResolver({ id: resolverId, type: "template", url, placeholders }) };
  }
  const resolver = parseResolver({
    id: resolverId,
    type: "s3",
    endpoint: required(form, "endpoint"),
    region: optional(form, "region") ?? "auto",
    bucket: required(form, "bucket"),
    pathStyle: formText(form, "pathStyle") === "on",
    keyTemplate: required(form, "keyTemplate"),
  });
  const accessKeyId = optional(form, "accessKeyId");
  const secretAccessKey = optional(form, "secretAccessKey");
  if (accessKeyId === undefined && secretAccessKey === undefined) return { resolver };
  if (accessKeyId === undefined || secretAccessKey === undefined) throw new AdminInputError();
  return { resolver, credential: { resolverId, accessKeyId, secretAccessKey } };
}

function parseResolver(candidate: z.input<typeof SOURCE_RESOLVER_SCHEMA>): SourceResolverPolicy {
  const result = SOURCE_RESOLVER_SCHEMA.safeParse(candidate);
  if (result.success) return result.data;
  throw new SpacePolicyValidationError(
    result.error.issues[0]?.message ?? "The resolver is not valid.",
  );
}

/** Reference segments typed into the Test panel: `value/value`, one per placeholder. */
export function parseTestReference(form: FormData): readonly string[] {
  const segments = required(form, "reference")
    .split("/")
    .map((segment) => segment.trim());
  if (segments.some((segment) => segment.length === 0)) throw new AdminInputError();
  return segments;
}
