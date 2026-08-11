import { Data } from "effect";

export type CapabilityErrorCode =
  | "capability_malformed"
  | "capability_too_large"
  | "unknown_version"
  | "unknown_key"
  | "authentication_failed"
  | "claims_invalid"
  | "capability_expired"
  | "capability_not_yet_valid"
  | "space_mismatch"
  | "purpose_mismatch"
  | "kind_mismatch"
  | "source_mismatch"
  | "locator_not_allowed";

export type QueryErrorCode = "query_invalid";
export type SubmissionErrorCode = "submission_invalid" | "request_invalid";

export type ProtocolErrorCode = CapabilityErrorCode | QueryErrorCode | SubmissionErrorCode;

export class CapabilityError extends Data.TaggedError("CapabilityError")<{
  readonly code: CapabilityErrorCode;
  readonly message: string;
}> {}

export class QueryError extends Data.TaggedError("QueryError")<{
  readonly code: QueryErrorCode;
  readonly message: string;
}> {}

export class SubmissionError extends Data.TaggedError("SubmissionError")<{
  readonly code: SubmissionErrorCode;
  readonly message: string;
}> {}

export type ProtocolError = CapabilityError | QueryError | SubmissionError;

export function isProtocolError(error: unknown): error is ProtocolError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  return (
    error._tag === "CapabilityError" ||
    error._tag === "QueryError" ||
    error._tag === "SubmissionError"
  );
}
