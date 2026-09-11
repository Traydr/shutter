import type { SHUTTER_FORMAT } from "./constants.js";

export type RouteClass = "public" | "private";
export type PreviewKind = "video" | "pdf";
export type CapabilityPurpose =
  | "image_source"
  | "source_delivery"
  | "master_preview"
  | "preview_job";

export interface CommonClaims {
  space_id: string;
  source_id: string;
  purpose: CapabilityPurpose;
  iat: number;
  exp: number;
}

export interface ImageSourceClaims extends CommonClaims {
  purpose: "image_source";
  locator: string;
}

export interface SourceDeliveryClaims extends CommonClaims {
  purpose: "source_delivery";
  locator: string;
}

export interface MasterPreviewClaims extends CommonClaims {
  purpose: "master_preview";
  kind: PreviewKind;
}

export interface PreviewJobClaims extends CommonClaims {
  purpose: "preview_job";
  kind: PreviewKind;
  locator: string;
}

export type SourceCapabilityClaims =
  | ImageSourceClaims
  | SourceDeliveryClaims
  | MasterPreviewClaims
  | PreviewJobClaims;

export interface SourceOriginRule {
  origin: string;
  pathPrefix?: string;
}

/**
 * The v1 UploadThing adapter. Retired by ADR 0025: the migration that lands
 * with the Control resolver editor rewrites every row into a template, after
 * which this member leaves the union.
 */
export interface UploadThingResolverPolicy {
  id: string;
  type: "uploadthing";
  allowedProjectIds: readonly string[];
}

/** What one `{name}` in a resolver template accepts beyond the reference grammar. */
export interface ResolverPlaceholderPolicy {
  /** The only values the placeholder accepts; required for a hostname placeholder. */
  allowed?: readonly string[];
}

/**
 * An HTTPS URL with one placeholder per path segment or hostname label, such
 * as `https://{project}.ufs.sh/f/{file}`. Resolved at the Edge from the
 * snapshot, no credential involved.
 */
export interface TemplateResolverPolicy {
  id: string;
  type: "template";
  url: string;
  placeholders: Readonly<Record<string, ResolverPlaceholderPolicy>>;
}

/**
 * An S3-compatible bucket read with a resolver-scoped credential that only
 * Control holds. These are the public fields; the credential lives in the
 * Space Registry beside the resolver and never in a policy or snapshot.
 */
export interface S3ResolverPolicy {
  id: string;
  type: "s3";
  /** HTTPS origin of the S3 endpoint, without a path. */
  endpoint: string;
  region: string;
  bucket: string;
  /** `true` addresses `{endpoint}/{bucket}/{key}`; `false` addresses `https://{bucket}.{host}/{key}`. */
  pathStyle: boolean;
  /** An object key with `{name}` placeholders, one per `/`-separated segment. */
  keyTemplate: string;
}

export type SourceResolverPolicy =
  | UploadThingResolverPolicy
  | TemplateResolverPolicy
  | S3ResolverPolicy;

interface BaseSpacePolicy {
  id: string;
  qualities: readonly number[];
  defaultQuality: number;
  allowedSourceOrigins: readonly SourceOriginRule[];
}

export interface PublicSpacePolicy extends BaseSpacePolicy {
  routeClass: "public";
  resolvers: readonly SourceResolverPolicy[];
}

export interface PrivateSpacePolicy extends BaseSpacePolicy {
  routeClass: "private";
  resolvers: readonly [];
}

export type SpacePolicy = PublicSpacePolicy | PrivateSpacePolicy;

export type JobStatus = "pending" | "processing" | "ready" | "failed";

export const FAILURE_ACTIONS = {
  source_expired: "renew_capability",
  attempts_exhausted: "retry",
  source_missing: "replace_source",
  unsupported_media: "replace_source",
  source_too_large: "replace_source",
  source_corrupt: "replace_source",
  pdf_password_protected: "replace_source",
  configuration_error: "contact_operator",
  internal_invariant: "contact_operator",
} as const;

export type JobFailureCode = keyof typeof FAILURE_ACTIONS;
export type JobFailureAction = (typeof FAILURE_ACTIONS)[JobFailureCode];

export type ActiveJobRepresentation = {
  status: "pending" | "processing";
};

export interface MasterPreviewDescriptor {
  sourceId: string;
  kind: PreviewKind;
  width: number;
  height: number;
  format: typeof SHUTTER_FORMAT;
}

export interface ReadyJobRepresentation {
  status: "ready";
  master: MasterPreviewDescriptor;
}

export type FailedJobRepresentation = {
  [Code in JobFailureCode]: {
    status: "failed";
    failure: {
      code: Code;
      action: (typeof FAILURE_ACTIONS)[Code];
    };
  };
}[JobFailureCode];

export type PreviewJobRepresentation =
  | ActiveJobRepresentation
  | ReadyJobRepresentation
  | FailedJobRepresentation;

export interface PreviewJobSubmission {
  sourceCapability: string;
}

export interface ExecutorClaim {
  spaceId: string;
  sourceId: string;
  kind: PreviewKind;
  locator: string;
  outputKey: string;
  processingToken: string;
  executionCycle: number;
  attemptNumber: number;
  allowedSourceOrigins: readonly SourceOriginRule[];
}

export interface ExecutorHeartbeatRequest {
  processingToken: string;
}

export interface ExecutorCompleteRequest {
  processingToken: string;
  masterKey: string;
  width: number;
  height: number;
  format: "webp";
  objectEtag: string;
}

export interface ExecutorFailRequest {
  processingToken: string;
  retryable: boolean;
  code?: JobFailureCode;
}

export type OptimizationInput = { type: "source" } | { type: "master"; kind: PreviewKind };
