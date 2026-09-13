/**
 * From what the operator typed to the body Control receives. Only the
 * shape is assembled here; every rule about values is Control's, so a
 * mistake comes back as Control's own message.
 */
import { resolverPlaceholders, type SourceResolverPolicy } from "@shutter/protocol";

/** What the operator typed does not form a request; the message says what to fix. */
export class FormInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormInputError";
  }
}

// The bodies the pages send. They mirror the wire request types but carry no
// `undefined` members, so they cross the server-function boundary as JSON.

// Type aliases rather than interfaces: an alias has the implicit index
// signature the server functions' JSON input type requires.

export type OriginRuleInput = {
  origin: string;
  pathPrefix?: string;
};

export type PolicyUpdateBody = {
  qualities: number[];
  defaultQuality: number;
  allowedSourceOrigins: OriginRuleInput[];
};

export type CreateSpaceBody = PolicyUpdateBody & {
  id: string;
  routeClass: string;
};

export type PlaceholderInput = {
  allowed?: string[];
};

export type PlaceholderInputs = Record<string, PlaceholderInput>;

export type TemplateResolverInput = {
  id: string;
  type: "template";
  url: string;
  placeholders: PlaceholderInputs;
};

export type S3ResolverInput = {
  id: string;
  type: "s3";
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  keyTemplate: string;
};

export type ResolverBody = {
  resolver: TemplateResolverInput | S3ResolverInput;
  credential?: { accessKeyId: string; secretAccessKey: string };
};

function lines(text: string): readonly string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function qualitiesList(text: string): number[] {
  return text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => Number(value));
}

/** One `origin[/prefix]` line to an allowed-source rule. */
export function originRules(text: string): OriginRuleInput[] {
  return lines(text).map((line) => {
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      throw new FormInputError(`"${line}" is not a URL.`);
    }
    const rule: OriginRuleInput = { origin: url.origin };
    if (url.pathname !== "/") rule.pathPrefix = url.pathname;
    return rule;
  });
}

export interface PolicyFields {
  qualities: string;
  defaultQuality: string;
  allowedSourceOrigins: string;
}

export function policyFields(policy: {
  qualities: readonly number[];
  defaultQuality: number;
  allowedSourceOrigins: readonly { origin: string; pathPrefix?: string | undefined }[];
}): PolicyFields {
  return {
    qualities: policy.qualities.join(", "),
    defaultQuality: String(policy.defaultQuality),
    allowedSourceOrigins: policy.allowedSourceOrigins
      .map((rule) => `${rule.origin}${rule.pathPrefix ?? ""}`)
      .join("\n"),
  };
}

export function policyUpdateBody(fields: PolicyFields): PolicyUpdateBody {
  return {
    qualities: qualitiesList(fields.qualities),
    defaultQuality: Number(fields.defaultQuality.trim()),
    allowedSourceOrigins: originRules(fields.allowedSourceOrigins),
  };
}

export function createSpaceBody(
  fields: PolicyFields & { id: string; routeClass: string },
): CreateSpaceBody {
  return { id: fields.id.trim(), routeClass: fields.routeClass, ...policyUpdateBody(fields) };
}

export type ResolverKind = "template" | "s3";

export interface ResolverFields {
  id: string;
  kind: ResolverKind;
  url: string;
  /** `name=value,value` lines. */
  allowed: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  keyTemplate: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const UPLOADTHING_TEMPLATE = "https://{project}.ufs.sh/f/{file}";

export function emptyResolverFields(kind: ResolverKind, preset?: "uploadthing"): ResolverFields {
  return {
    id: "",
    kind,
    url: preset === "uploadthing" ? UPLOADTHING_TEMPLATE : "",
    allowed: preset === "uploadthing" ? "project=" : "",
    endpoint: "",
    region: "auto",
    bucket: "",
    pathStyle: true,
    keyTemplate: "{key}",
    accessKeyId: "",
    secretAccessKey: "",
  };
}

/** The editor's fields for a stored resolver; the retired UploadThing kind has no editor. */
export function resolverFields(resolver: SourceResolverPolicy): ResolverFields | undefined {
  if (resolver.type === "uploadthing") return undefined;
  const fields = emptyResolverFields(resolver.type);
  fields.id = resolver.id;
  if (resolver.type === "template") {
    fields.url = resolver.url;
    fields.allowed = Object.entries(resolver.placeholders)
      .filter(([, placeholder]) => placeholder.allowed !== undefined)
      .map(([name, placeholder]) => `${name}=${(placeholder.allowed ?? []).join(",")}`)
      .join("\n");
    return fields;
  }
  fields.endpoint = resolver.endpoint;
  fields.region = resolver.region;
  fields.bucket = resolver.bucket;
  fields.pathStyle = resolver.pathStyle;
  fields.keyTemplate = resolver.keyTemplate;
  return fields;
}

/** Every `{name}` in a template, in order of appearance. */
export function placeholderNames(template: string): readonly string[] {
  return [...template.matchAll(/\{([^{}]*)\}/gu)].map((match) => match[1] ?? "");
}

/** The placeholders that sit in the hostname of a URL template; each must list its values. */
export function hostnamePlaceholders(url: string): readonly string[] {
  const authority = /^[a-z]+:\/\/([^/]*)/iu.exec(url)?.[1] ?? "";
  return placeholderNames(authority);
}

function allowedLines(allowed: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of lines(allowed)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return entries;
}

/** The comma-separated values the editor shows for one placeholder. */
export function allowedFor(allowed: string, name: string): string {
  return allowedLines(allowed).get(name) ?? "";
}

/** The `allowed` lines with one placeholder's values replaced; an empty value drops the line. */
export function withAllowed(allowed: string, name: string, values: string): string {
  const entries = allowedLines(allowed);
  if (values.trim().length === 0) entries.delete(name);
  else entries.set(name, values);
  return [...entries].map(([key, value]) => `${key}=${value}`).join("\n");
}

/** The request pattern a source answers, from what the editor holds: `id/{a}/{b}`. */
export function requestPattern(fields: ResolverFields): string {
  const names = placeholderNames(fields.kind === "template" ? fields.url : fields.keyTemplate);
  return [fields.id.trim() || "…", ...names.map((name) => `{${name}}`)].join("/");
}

function allowedValues(text: string) {
  const placeholders: PlaceholderInputs = {};
  for (const line of lines(text)) {
    const separator = line.indexOf("=");
    if (separator < 1) throw new FormInputError(`"${line}" is not a name=value,value line.`);
    const name = line.slice(0, separator).trim();
    const values = line
      .slice(separator + 1)
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    placeholders[name] = values.length === 0 ? {} : { allowed: values };
  }
  return placeholders;
}

export function resolverBody(fields: ResolverFields): ResolverBody {
  const id = fields.id.trim();
  if (fields.kind === "template") {
    const url = fields.url.trim();
    const restricted = allowedValues(fields.allowed);
    // Only the URL's own placeholders travel: a value list left over from an
    // earlier draft of the URL would otherwise be sent and rejected.
    const placeholders: PlaceholderInputs = {};
    for (const name of placeholderNames(url)) placeholders[name] = restricted[name] ?? {};
    return { resolver: { id, type: "template", url, placeholders } };
  }
  const request: ResolverBody = {
    resolver: {
      id,
      type: "s3",
      endpoint: fields.endpoint.trim(),
      region: fields.region.trim().length === 0 ? "auto" : fields.region.trim(),
      bucket: fields.bucket.trim(),
      pathStyle: fields.pathStyle,
      keyTemplate: fields.keyTemplate.trim(),
    },
  };
  const accessKeyId = fields.accessKeyId.trim();
  const secretAccessKey = fields.secretAccessKey.trim();
  if (accessKeyId.length === 0 && secretAccessKey.length === 0) return request;
  if (accessKeyId.length === 0 || secretAccessKey.length === 0) {
    throw new FormInputError("Enter both halves of the credential, or neither.");
  }
  request.credential = { accessKeyId, secretAccessKey };
  return request;
}

/** `value/value` typed into the Test panel, one segment per placeholder. */
export function referenceSegments(text: string): readonly string[] {
  const segments = text.split("/").map((segment) => segment.trim());
  if (segments.some((segment) => segment.length === 0)) {
    throw new FormInputError("Every segment of the reference must be non-empty.");
  }
  return segments;
}

/** The placeholder names in template order; empty for a resolver the protocol cannot read. */
export function placeholdersOf(resolver: SourceResolverPolicy): readonly string[] {
  try {
    return resolverPlaceholders(resolver);
  } catch {
    return [];
  }
}

/** A complete v2 Delivery URL with placeholder names where the reference goes. */
export function exampleDeliveryUrl(
  edgeBaseUrl: string | undefined,
  spaceId: string,
  resolver: SourceResolverPolicy,
  defaultQuality: number,
): string {
  const reference = placeholdersOf(resolver)
    .map((name) => `{${name}}`)
    .join("/");
  const path = `/v2/${spaceId}/${resolver.id}/${reference}?w=1200&q=${defaultQuality}`;
  return `${edgeBaseUrl ?? ""}${path}`;
}
