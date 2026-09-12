/**
 * The `/v1/admin` wire between Control and the admin application. Every
 * timestamp is an ISO instant string; every mutation answers with the registry
 * generation it produced; a credential's secret travels once, in the body of
 * the response that issued it, and never again.
 */
import {
  type JsonValue,
  parseSpacePolicy,
  SOURCE_ORIGIN_RULES_SCHEMA,
  SOURCE_RESOLVER_SCHEMA,
  SPACE_POLICY_SCHEMA,
  type SpacePolicy,
  SpacePolicyValidationError,
} from "@shutter/protocol";
import { z } from "zod";

// Common fields

const timestamp = z.string().refine(
  (value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  },
  { error: "expected an ISO timestamp" },
);

const generation = z.int().nonnegative();

const nonEmpty = z.string().min(1);

/** The coverage of active Space origins by the deployed imgproxy allowlist. */
export const DEPLOYMENT_COVERAGE_SCHEMA = z.strictObject({
  derivedValue: z.string(),
  uncovered: z.array(z.string()).readonly(),
});
export type DeploymentCoverageWire = z.output<typeof DEPLOYMENT_COVERAGE_SCHEMA>;

// Spaces

export const ADMIN_SPACE_SCHEMA = z.strictObject({
  policy: SPACE_POLICY_SCHEMA,
  status: z.enum(["active", "decommissioned"]),
  createdAt: timestamp,
  updatedAt: timestamp,
  decommissionedAt: timestamp.optional(),
});
export type AdminSpace = z.output<typeof ADMIN_SPACE_SCHEMA>;

export const ADMIN_API_TOKEN_SCHEMA = z.strictObject({
  id: z.int().positive(),
  label: z.string(),
  displayPrefix: z.string(),
  createdAt: timestamp,
  lastUsedAt: timestamp.optional(),
  revokedAt: timestamp.optional(),
});
export type AdminApiToken = z.output<typeof ADMIN_API_TOKEN_SCHEMA>;

export const ADMIN_CAPABILITY_KEY_SCHEMA = z.strictObject({
  id: z.int().positive(),
  keyId: z.string(),
  acceptedAt: timestamp,
  disabledAt: timestamp.optional(),
});
export type AdminCapabilityKey = z.output<typeof ADMIN_CAPABILITY_KEY_SCHEMA>;

/** What the admin may know about a stored `s3` credential: never the secret. */
export const ADMIN_RESOLVER_CREDENTIAL_SCHEMA = z.strictObject({
  resolverId: z.string(),
  accessKeyId: z.string(),
  updatedAt: timestamp,
});
export type AdminResolverCredential = z.output<typeof ADMIN_RESOLVER_CREDENTIAL_SCHEMA>;

export const EDGE_REFRESH_SCHEMA = z.strictObject({
  generation,
  refreshedAt: timestamp,
});
export type EdgeRefreshWire = z.output<typeof EDGE_REFRESH_SCHEMA>;

export const ADMIN_OVERVIEW_SCHEMA = z.strictObject({
  generation,
  registryUpdatedAt: timestamp,
  spaces: z.array(ADMIN_SPACE_SCHEMA).readonly(),
  coverage: DEPLOYMENT_COVERAGE_SCHEMA,
  edgeRefresh: EDGE_REFRESH_SCHEMA.optional(),
  edgeBaseUrl: z.string().optional(),
});
export type AdminOverview = z.output<typeof ADMIN_OVERVIEW_SCHEMA>;

export const ADMIN_SPACE_DETAIL_SCHEMA = z.strictObject({
  generation,
  space: ADMIN_SPACE_SCHEMA,
  apiTokens: z.array(ADMIN_API_TOKEN_SCHEMA).readonly(),
  capabilityKeys: z.array(ADMIN_CAPABILITY_KEY_SCHEMA).readonly(),
  resolverCredentials: z.array(ADMIN_RESOLVER_CREDENTIAL_SCHEMA).readonly(),
  /** Coverage of this Space's origins alone. */
  coverage: DEPLOYMENT_COVERAGE_SCHEMA,
  edgeBaseUrl: z.string().optional(),
});
export type AdminSpaceDetail = z.output<typeof ADMIN_SPACE_DETAIL_SCHEMA>;

/** The answer to every Space or resolver mutation: the new generation and the Space as stored. */
export const SPACE_MUTATION_SCHEMA = z.strictObject({
  generation,
  space: ADMIN_SPACE_SCHEMA,
});
export type SpaceMutation = z.output<typeof SPACE_MUTATION_SCHEMA>;

/**
 * A new Space: the policy fields an operator chooses. Resolvers are added
 * afterwards through their own routes, so a create carries none.
 */
export const CREATE_SPACE_REQUEST_SCHEMA = z
  .strictObject({
    id: z.string(),
    routeClass: z.string(),
    qualities: z.array(z.int()),
    defaultQuality: z.int(),
    allowedSourceOrigins: z.array(
      z.strictObject({ origin: z.string(), pathPrefix: z.string().optional() }),
    ),
  })
  .transform((input, context): SpacePolicy => {
    try {
      return parseSpacePolicy({ ...input, resolvers: [] });
    } catch (error) {
      context.addIssue(
        error instanceof SpacePolicyValidationError ? error.message : "Space policy is invalid",
      );
      return z.NEVER;
    }
  });
export type CreateSpaceRequest = z.input<typeof CREATE_SPACE_REQUEST_SCHEMA>;

/** The policy fields that may change after creation; the registry keeps the resolver list. */
export const UPDATE_SPACE_POLICY_REQUEST_SCHEMA = z.strictObject({
  qualities: z.array(z.int()).readonly(),
  defaultQuality: z.int(),
  allowedSourceOrigins: SOURCE_ORIGIN_RULES_SCHEMA,
});
export type UpdateSpacePolicyRequest = z.input<typeof UPDATE_SPACE_POLICY_REQUEST_SCHEMA>;
export type SpacePolicyUpdateWire = z.output<typeof UPDATE_SPACE_POLICY_REQUEST_SCHEMA>;

// Resolvers

const resolverCredentialInput = z.strictObject({
  accessKeyId: nonEmpty,
  secretAccessKey: nonEmpty,
});
export type ResolverCredentialWire = z.output<typeof resolverCredentialInput>;

/**
 * A resolver to store, as the protocol defines it, plus the credential an `s3`
 * resolver reads with. On a replace the credential is optional: absent keeps
 * the stored pair. The resolver's `id` must match the route it is sent to.
 */
export const RESOLVER_REQUEST_SCHEMA = z.strictObject({
  resolver: SOURCE_RESOLVER_SCHEMA,
  credential: resolverCredentialInput.optional(),
});
export type ResolverRequest = z.input<typeof RESOLVER_REQUEST_SCHEMA>;
export type ResolverRequestParsed = z.output<typeof RESOLVER_REQUEST_SCHEMA>;

/** The sample reference the Test panel resolves: one segment per placeholder. */
export const TEST_RESOLVER_REQUEST_SCHEMA = z.strictObject({
  reference: z.array(nonEmpty).min(1).readonly(),
});
export type TestResolverRequest = z.input<typeof TEST_RESOLVER_REQUEST_SCHEMA>;

/** What a resolver test reports; the resolved locator itself never travels. */
export const RESOLVER_TEST_RESULT_SCHEMA = z.strictObject({
  outcome: z.enum(["ok", "failed"]),
  message: z.string(),
  sourceId: z.string().optional(),
  host: z.string().optional(),
  status: z.int().optional(),
  contentType: z.string().optional(),
  contentLength: z.int().nonnegative().optional(),
});
export type ResolverTestResultWire = z.output<typeof RESOLVER_TEST_RESULT_SCHEMA>;

// Credentials

export const ISSUE_API_TOKEN_REQUEST_SCHEMA = z.strictObject({ label: nonEmpty.max(128) });
export type IssueApiTokenRequest = z.input<typeof ISSUE_API_TOKEN_REQUEST_SCHEMA>;

export const ISSUED_API_TOKEN_SCHEMA = z.strictObject({
  generation,
  apiToken: ADMIN_API_TOKEN_SCHEMA,
  /** The full token, shown once. */
  secret: z.string(),
});
export type IssuedApiToken = z.output<typeof ISSUED_API_TOKEN_SCHEMA>;

export const API_TOKEN_MUTATION_SCHEMA = z.strictObject({
  generation,
  apiToken: ADMIN_API_TOKEN_SCHEMA,
});
export type ApiTokenMutation = z.output<typeof API_TOKEN_MUTATION_SCHEMA>;

export const ADD_CAPABILITY_KEY_REQUEST_SCHEMA = z.strictObject({ keyId: nonEmpty.max(64) });
export type AddCapabilityKeyRequest = z.input<typeof ADD_CAPABILITY_KEY_REQUEST_SCHEMA>;

export const ISSUED_CAPABILITY_KEY_SCHEMA = z.strictObject({
  generation,
  capabilityKey: ADMIN_CAPABILITY_KEY_SCHEMA,
  /** The base64url key material, shown once. */
  secret: z.string(),
});
export type IssuedCapabilityKey = z.output<typeof ISSUED_CAPABILITY_KEY_SCHEMA>;

export const CAPABILITY_KEY_MUTATION_SCHEMA = z.strictObject({
  generation,
  capabilityKey: ADMIN_CAPABILITY_KEY_SCHEMA,
});
export type CapabilityKeyMutation = z.output<typeof CAPABILITY_KEY_MUTATION_SCHEMA>;

// Problems

/** The RFC 9457 body every admin route answers errors with; `detail` names the rejected input. */
export const ADMIN_PROBLEM_SCHEMA = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  code: z.string(),
  detail: z.string().optional(),
  requestId: z.string().optional(),
});
export type AdminProblem = z.output<typeof ADMIN_PROBLEM_SCHEMA>;

export class AdminWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminWireError";
  }
}

const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/u;

/**
 * Where an issue sits, as far as the path stays inside this contract's own
 * field names and array indexes. A record key or an unknown key is submitted
 * text, so the path stops before it and nothing submitted is echoed.
 */
function issueLocation(path: readonly PropertyKey[]): string {
  const segments: string[] = [];
  for (const segment of path) {
    const text = String(segment);
    if (!FIELD_NAME.test(text) && !/^\d+$/u.test(text)) break;
    segments.push(text);
  }
  return segments.length === 0 ? "the document" : segments.join(".");
}

/**
 * One line for the first issue. A `custom` issue carries a curated message
 * from this contract or the protocol schemas; every other issue is reduced to
 * its location and zod's description of the expected value, never the value.
 */
function issueMessage(issue: z.core.$ZodIssue): string {
  const location = issueLocation(issue.path);
  switch (issue.code) {
    case "custom":
      return issue.message;
    case "unrecognized_keys":
      return `${location} has an unknown field`;
    default:
      return `${location}: ${issue.message}`;
  }
}

/**
 * Parses a decoded JSON document with one of the wire schemas, naming the
 * first issue without echoing submitted text. Both ends use it: Control on
 * request bodies, the client on response bodies.
 */
export function parseWire<Schema extends z.ZodType>(
  schema: Schema,
  value: JsonValue,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new AdminWireError(issue === undefined ? "the document is not valid" : issueMessage(issue));
}
