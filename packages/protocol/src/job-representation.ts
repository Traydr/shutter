import type { FailedJobRepresentation, JobFailureCode } from "./types.js";
import { FAILURE_ACTIONS } from "./types.js";

export function createFailedJobRepresentation(code: JobFailureCode): FailedJobRepresentation {
  return {
    status: "failed",
    failure: { code, action: FAILURE_ACTIONS[code] },
  } as FailedJobRepresentation;
}
