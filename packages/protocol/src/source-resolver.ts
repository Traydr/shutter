import { validateSourceLocator } from "./source-locator.js";
import type {
  S3ResolverPolicy,
  SourceOriginRule,
  SourceResolverPolicy,
  TemplateResolverPolicy,
} from "./types.js";

/**
 * Source Resolver templates and references.
 *
 * A template is an HTTPS URL (or, for an S3 resolver, an object key) in which
 * `{name}` stands for exactly one whole path segment or hostname label. A
 * reference is the list of values for those placeholders, in the order they
 * appear. This module owns the grammar for both, the expansion of a reference
 * into a fetch location, and the Source ID a resolver source gets.
 */

const PLACEHOLDER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const PLACEHOLDER_PATTERN = /^\{([a-z][a-z0-9_]{0,31})\}$/u;
/** One decoded reference segment. Never `.` or `..`, which the grammar cannot produce. */
const REFERENCE_SEGMENT_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,512}$/u;
/** A hostname label a placeholder may take. `_` is tolerated because existing UploadThing ids use it. */
const HOST_LABEL_PATTERN = /^[A-Za-z0-9_-]{1,63}$/u;
/** A literal path segment or key segment: unreserved characters only. */
const LITERAL_SEGMENT_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._~-]+$/u;

export type TemplatePart =
  | { kind: "literal"; value: string }
  | { kind: "placeholder"; name: string };

export interface ParsedUrlTemplate {
  hostLabels: readonly TemplatePart[];
  pathSegments: readonly TemplatePart[];
  /** Placeholder names in order of appearance: hostname first, then path. */
  placeholders: readonly string[];
  /** The placeholder in the hostname, when there is one. */
  hostPlaceholder: string | undefined;
}

export interface ParsedKeyTemplate {
  segments: readonly TemplatePart[];
  placeholders: readonly string[];
}

export class ResolverTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolverTemplateError";
  }
}

function templatePart(raw: string, literalPattern: RegExp, where: string): TemplatePart {
  const placeholder = PLACEHOLDER_PATTERN.exec(raw);
  if (placeholder !== null) {
    const name = placeholder[1] ?? "";
    return { kind: "placeholder", name };
  }
  if (raw.includes("{") || raw.includes("}")) {
    throw new ResolverTemplateError(`a placeholder must be one whole ${where}`);
  }
  if (!literalPattern.test(raw)) {
    throw new ResolverTemplateError(`a literal ${where} contains unsupported characters`);
  }
  return { kind: "literal", value: raw };
}

function placeholderNames(parts: readonly TemplatePart[]): string[] {
  const names: string[] = [];
  for (const part of parts) {
    if (part.kind !== "placeholder") continue;
    if (names.includes(part.name)) {
      throw new ResolverTemplateError(`placeholder {${part.name}} appears more than once`);
    }
    names.push(part.name);
  }
  return names;
}

/** Parses a template resolver URL. Throws `ResolverTemplateError` with the first violation. */
export function parseUrlTemplate(url: string): ParsedUrlTemplate {
  if (!url.startsWith("https://")) {
    throw new ResolverTemplateError("a resolver template must start with https://");
  }
  if (url.includes("?") || url.includes("#") || url.includes("@")) {
    throw new ResolverTemplateError(
      "a resolver template cannot contain credentials, a query, or a fragment",
    );
  }
  const rest = url.slice("https://".length);
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "" : rest.slice(slash + 1);
  if (host.length === 0) throw new ResolverTemplateError("a resolver template needs a hostname");
  const hostLabels = host
    .split(".")
    .map((label) => templatePart(label, HOST_LABEL_PATTERN, "hostname label"));
  const hostPlaceholders = placeholderNames(hostLabels);
  if (hostPlaceholders.length > 1) {
    throw new ResolverTemplateError("at most one placeholder may sit in the hostname");
  }
  const pathSegments =
    path.length === 0
      ? []
      : path
          .split("/")
          .map((segment) => templatePart(segment, LITERAL_SEGMENT_PATTERN, "path segment"));
  const placeholders = [...hostPlaceholders, ...placeholderNames(pathSegments)];
  if (new Set(placeholders).size !== placeholders.length) {
    throw new ResolverTemplateError("a placeholder name appears more than once");
  }
  if (placeholders.length === 0) {
    throw new ResolverTemplateError("a resolver template needs at least one placeholder");
  }
  return { hostLabels, pathSegments, placeholders, hostPlaceholder: hostPlaceholders[0] };
}

/** Parses an S3 key template: `/`-separated segments, no leading slash, at least one placeholder. */
export function parseKeyTemplate(keyTemplate: string): ParsedKeyTemplate {
  if (keyTemplate.length === 0 || keyTemplate.startsWith("/") || keyTemplate.endsWith("/")) {
    throw new ResolverTemplateError("a key template cannot be empty or start or end with /");
  }
  const segments = keyTemplate
    .split("/")
    .map((segment) => templatePart(segment, LITERAL_SEGMENT_PATTERN, "key segment"));
  const placeholders = placeholderNames(segments);
  if (placeholders.length === 0) {
    throw new ResolverTemplateError("a key template needs at least one placeholder");
  }
  return { segments, placeholders };
}

export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAME_PATTERN.test(name);
}

export function isReferenceSegment(value: string): boolean {
  return REFERENCE_SEGMENT_PATTERN.test(value);
}

export function isHostLabel(value: string): boolean {
  return HOST_LABEL_PATTERN.test(value);
}

/**
 * The placeholder names a resolver's reference must supply, in order. A
 * retired UploadThing resolver takes the v1 `project/file` pair.
 */
export function resolverPlaceholders(resolver: SourceResolverPolicy): readonly string[] {
  switch (resolver.type) {
    case "uploadthing":
      return ["project", "file"];
    case "template":
      return parseUrlTemplate(resolver.url).placeholders;
    case "s3":
      return parseKeyTemplate(resolver.keyTemplate).placeholders;
  }
}

/** A reference accepted by a resolver, with the Source ID it names. */
export interface SourceReference {
  sourceId: string;
  /** One value per placeholder, in placeholder order. */
  values: readonly string[];
}

/** The Source ID of a resolver source: the resolver ID and the reference values joined by `/`. */
export function resolverSourceId(resolverId: string, values: readonly string[]): string {
  return `${resolverId}/${values.join("/")}`;
}

/**
 * Checks decoded reference segments against a resolver: the segment count
 * equals the placeholder count, every segment is in the reference grammar,
 * and a placeholder with an allowed list gets one of its values. Returns
 * `undefined` for anything else so callers answer one uniform 404.
 */
export function parseSourceReference(
  resolver: SourceResolverPolicy,
  segments: readonly string[],
): SourceReference | undefined {
  let placeholders: readonly string[];
  try {
    placeholders = resolverPlaceholders(resolver);
  } catch {
    return undefined;
  }
  if (segments.length !== placeholders.length) return undefined;
  for (const [index, name] of placeholders.entries()) {
    const value = segments[index];
    if (value === undefined || !isReferenceSegment(value)) return undefined;
    const allowed = allowedValues(resolver, name);
    if (allowed !== undefined && !allowed.includes(value)) return undefined;
  }
  return { sourceId: resolverSourceId(resolver.id, segments), values: segments };
}

function allowedValues(
  resolver: SourceResolverPolicy,
  name: string,
): readonly string[] | undefined {
  switch (resolver.type) {
    case "uploadthing":
      return name === "project" ? resolver.allowedProjectIds : undefined;
    case "template":
      return resolver.placeholders[name]?.allowed;
    case "s3":
      return undefined;
  }
}

function substitute(
  parts: readonly TemplatePart[],
  values: ReadonlyMap<string, string>,
  encode: (value: string) => string,
): string[] {
  return parts.map((part) => {
    if (part.kind === "literal") return part.value;
    const value = values.get(part.name);
    if (value === undefined) throw new ResolverTemplateError(`no value for {${part.name}}`);
    return encode(value);
  });
}

function identity(value: string): string {
  return value;
}

function valuesByName(
  placeholders: readonly string[],
  values: readonly string[],
): Map<string, string> {
  if (values.length !== placeholders.length) {
    throw new ResolverTemplateError("the reference has the wrong number of segments");
  }
  return new Map(placeholders.map((name, index) => [name, values[index] ?? ""]));
}

/**
 * The fetch location of a template resolver for one reference. Hostname
 * values are inserted as labels, path values are percent-encoded once.
 */
export function expandTemplateResolver(
  resolver: TemplateResolverPolicy,
  values: readonly string[],
): string {
  const template = parseUrlTemplate(resolver.url);
  const named = valuesByName(template.placeholders, values);
  const host = substitute(template.hostLabels, named, identity).join(".");
  const path = substitute(template.pathSegments, named, encodeURIComponent).join("/");
  return `https://${host}/${path}`;
}

/** Where an S3 resolver's object lives for one reference, before signing. */
export interface S3ObjectLocation {
  /** The object key inside the bucket, unencoded. */
  key: string;
  /** The unsigned HTTPS URL of the object under the resolver's addressing style. */
  url: string;
}

export function expandS3Resolver(
  resolver: S3ResolverPolicy,
  values: readonly string[],
): S3ObjectLocation {
  const template = parseKeyTemplate(resolver.keyTemplate);
  const named = valuesByName(template.placeholders, values);
  const keySegments = substitute(template.segments, named, identity);
  const key = keySegments.join("/");
  const encodedKey = keySegments.map(encodeURIComponent).join("/");
  const endpoint = new URL(resolver.endpoint);
  const url = resolver.pathStyle
    ? `${endpoint.origin}/${encodeURIComponent(resolver.bucket)}/${encodedKey}`
    : `https://${resolver.bucket}.${endpoint.host}/${encodedKey}`;
  return { key, url };
}

/**
 * The literal part of a template path: every segment before the first
 * placeholder, as a URL path. A reference segment never contains `/`, so a
 * location a resolver produces always sits under this prefix; an allowlist
 * rule that covers the prefix covers every expansion.
 */
function literalPathPrefix(parts: readonly TemplatePart[]): string {
  const literal: string[] = [];
  for (const part of parts) {
    if (part.kind === "placeholder") break;
    literal.push(part.value);
  }
  return literal.length === 0 ? "/" : `/${literal.join("/")}`;
}

/**
 * Every origin-and-prefix shape a resolver can produce: one per allowed value
 * of a hostname placeholder, with the literal path before the first path
 * placeholder. Checking these against the allowlist proves every expansion is
 * inside it without guessing at reference values.
 */
export function resolverOriginPrefixes(resolver: SourceResolverPolicy): readonly string[] {
  switch (resolver.type) {
    case "uploadthing":
      return resolver.allowedProjectIds.map((projectId) => `https://${projectId}.ufs.sh/f`);
    case "template": {
      const template = parseUrlTemplate(resolver.url);
      const path = literalPathPrefix(template.pathSegments);
      const hostValues =
        template.hostPlaceholder === undefined
          ? [undefined]
          : (resolver.placeholders[template.hostPlaceholder]?.allowed ?? []);
      return hostValues.map((hostValue) => {
        const host = template.hostLabels
          .map((label) => (label.kind === "literal" ? label.value : (hostValue ?? "")))
          .join(".");
        return `https://${host}${path}`;
      });
    }
    case "s3": {
      const template = parseKeyTemplate(resolver.keyTemplate);
      const keyPrefix = literalPathPrefix(template.segments);
      const endpoint = new URL(resolver.endpoint);
      return [
        resolver.pathStyle
          ? `${endpoint.origin}/${encodeURIComponent(resolver.bucket)}${keyPrefix === "/" ? "" : keyPrefix}`
          : `https://${resolver.bucket}.${endpoint.host}${keyPrefix}`,
      ];
    }
  }
}

/** Throws for the first origin prefix a resolver can produce outside the Space's allowed origins. */
export function validateResolverOrigins(
  resolver: SourceResolverPolicy,
  rules: readonly SourceOriginRule[],
): void {
  for (const prefix of resolverOriginPrefixes(resolver)) validateSourceLocator(prefix, rules);
}
