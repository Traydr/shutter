import { ProtocolError } from "./errors.js";
import type { FailedJobRepresentation, JobFailureCode, PreviewJobSubmission } from "./types.js";
import { FAILURE_ACTIONS } from "./types.js";

export function createFailedJobRepresentation(code: JobFailureCode): FailedJobRepresentation {
  return {
    status: "failed",
    failure: { code, action: FAILURE_ACTIONS[code] },
  } as FailedJobRepresentation;
}

export function parsePreviewJobSubmission(input: unknown): PreviewJobSubmission {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolError("submission_invalid", "job submission must be a JSON object");
  }

  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.sourceCapability !== "string" ||
    record.sourceCapability.length === 0
  ) {
    throw new ProtocolError(
      "submission_invalid",
      "job submission must contain only a non-empty sourceCapability",
    );
  }

  return { sourceCapability: record.sourceCapability };
}
