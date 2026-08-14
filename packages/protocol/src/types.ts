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

export interface UploadThingResolverPolicy {
  id: string;
  type: "uploadthing";
  allowedProjectIds: readonly string[];
}

export type SourceResolverPolicy = UploadThingResolverPolicy;

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
