export type ProtocolErrorCode =
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
  | "locator_not_allowed"
  | "query_invalid"
  | "submission_invalid"
  | "request_invalid";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}
