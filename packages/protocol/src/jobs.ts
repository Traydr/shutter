import { ProtocolError } from "./errors.js";
import { parseSourceOriginRules, SpacePolicyValidationError } from "./space-policy.js";
import type {
  ExecutorClaim,
  ExecutorCompleteRequest,
  ExecutorFailRequest,
  ExecutorHeartbeatRequest,
  FailedJobRepresentation,
  JobFailureCode,
  PreviewJobSubmission,
  PreviewKind,
  SourceOriginRule,
} from "./types.js";
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

function requireObject(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolError("request_invalid", `${label} must be a JSON object`);
  }
  return input as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  options?: { allowEmpty?: boolean },
): string {
  const value = record[key];
  if (typeof value !== "string" || (!options?.allowEmpty && value.length === 0)) {
    throw new ProtocolError("request_invalid", `${key} must be a non-empty string`);
  }
  return value;
}

function requireKind(value: unknown): PreviewKind {
  if (value !== "video" && value !== "pdf") {
    throw new ProtocolError("request_invalid", "kind must be video or pdf");
  }
  return value;
}

function requireSafeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ProtocolError("request_invalid", `${key} must be a safe integer`);
  }
  return value;
}

export function parseExecutorClaim(input: unknown): ExecutorClaim {
  const record = requireObject(input, "executor claim");
  const expectedKeys = [
    "allowedSourceOrigins",
    "attemptNumber",
    "executionCycle",
    "kind",
    "locator",
    "outputKey",
    "processingToken",
    "sourceId",
    "spaceId",
  ];
  if (Object.keys(record).sort().join(",") !== expectedKeys.join(",")) {
    throw new ProtocolError("request_invalid", "executor claim has unexpected fields");
  }
  let allowedSourceOrigins: readonly SourceOriginRule[];
  try {
    allowedSourceOrigins = parseSourceOriginRules(record.allowedSourceOrigins);
  } catch (error) {
    if (error instanceof SpacePolicyValidationError) {
      throw new ProtocolError("request_invalid", "allowedSourceOrigins is invalid");
    }
    throw error;
  }
  return {
    spaceId: requireString(record, "spaceId"),
    sourceId: requireString(record, "sourceId"),
    kind: requireKind(record.kind),
    locator: requireString(record, "locator"),
    outputKey: requireString(record, "outputKey"),
    processingToken: requireString(record, "processingToken"),
    executionCycle: requireSafeInteger(record, "executionCycle"),
    attemptNumber: requireSafeInteger(record, "attemptNumber"),
    allowedSourceOrigins,
  };
}

export function parseExecutorHeartbeatRequest(input: unknown): ExecutorHeartbeatRequest {
  const record = requireObject(input, "executor heartbeat");
  if (Object.keys(record).sort().join(",") !== "processingToken") {
    throw new ProtocolError("request_invalid", "executor heartbeat has unexpected fields");
  }
  return { processingToken: requireString(record, "processingToken") };
}

export function parseExecutorCompleteRequest(input: unknown): ExecutorCompleteRequest {
  const record = requireObject(input, "executor completion");
  if (
    Object.keys(record).sort().join(",") !==
    "format,height,masterKey,objectEtag,processingToken,width"
  ) {
    throw new ProtocolError("request_invalid", "executor completion has unexpected fields");
  }
  if (record.format !== "webp") {
    throw new ProtocolError("request_invalid", "format must be webp");
  }
  return {
    processingToken: requireString(record, "processingToken"),
    masterKey: requireString(record, "masterKey"),
    width: requireSafeInteger(record, "width"),
    height: requireSafeInteger(record, "height"),
    format: "webp",
    objectEtag: requireString(record, "objectEtag", { allowEmpty: true }),
  };
}

export function parseExecutorFailRequest(input: unknown): ExecutorFailRequest {
  const record = requireObject(input, "executor failure");
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "processingToken,retryable" && keys !== "code,processingToken,retryable") {
    throw new ProtocolError("request_invalid", "executor failure has unexpected fields");
  }
  if (typeof record.retryable !== "boolean") {
    throw new ProtocolError("request_invalid", "retryable must be a boolean");
  }
  const processingToken = requireString(record, "processingToken");
  if (record.code === undefined) return { processingToken, retryable: record.retryable };
  if (typeof record.code !== "string" || !(record.code in FAILURE_ACTIONS)) {
    throw new ProtocolError("request_invalid", "failure code is not recognized");
  }
  return {
    processingToken,
    retryable: record.retryable,
    code: record.code as JobFailureCode,
  };
}
