import { z } from "zod";
import { ProtocolError, type ProtocolErrorCode } from "./errors.js";
import type { JsonValue } from "./json.js";
import { SOURCE_ORIGIN_RULES_SCHEMA } from "./space-policy.js";
import type {
  ExecutorClaim,
  ExecutorCompleteRequest,
  ExecutorFailRequest,
  ExecutorHeartbeatRequest,
  FailedJobRepresentation,
  JobFailureCode,
  PreviewJobSubmission,
} from "./types.js";
import { FAILURE_ACTIONS } from "./types.js";

export function createFailedJobRepresentation(code: JobFailureCode): FailedJobRepresentation {
  // SAFETY: FAILURE_ACTIONS maps every code to its own action, so the pair is
  // one member of the FailedJobRepresentation union; TypeScript cannot
  // correlate the two indexed accesses on a generic key.
  return {
    status: "failed",
    failure: { code, action: FAILURE_ACTIONS[code] },
  } as FailedJobRepresentation;
}

const nonEmptyString = z.string().min(1);
const previewKindSchema = z.enum(["video", "pdf"], { error: "kind must be video or pdf" });

const previewJobSubmissionSchema = z.strictObject({
  sourceCapability: nonEmptyString,
});

const executorClaimSchema = z.strictObject({
  spaceId: nonEmptyString,
  sourceId: nonEmptyString,
  kind: previewKindSchema,
  locator: nonEmptyString,
  outputKey: nonEmptyString,
  processingToken: nonEmptyString,
  executionCycle: z.int(),
  attemptNumber: z.int(),
  allowedSourceOrigins: SOURCE_ORIGIN_RULES_SCHEMA,
});

const executorHeartbeatRequestSchema = z.strictObject({
  processingToken: nonEmptyString,
});

const executorCompleteRequestSchema = z.strictObject({
  processingToken: nonEmptyString,
  masterKey: nonEmptyString,
  width: z.int(),
  height: z.int(),
  format: z.literal("webp", { error: "format must be webp" }),
  objectEtag: z.string(),
});

const failureCodeSchema = z
  .string()
  .refine((code): code is JobFailureCode => Object.hasOwn(FAILURE_ACTIONS, code), {
    error: "failure code is not recognized",
  });

const executorFailRequestSchema = z.strictObject({
  processingToken: nonEmptyString,
  retryable: z.boolean(),
  code: failureCodeSchema.optional(),
});

function parseWith<Output>(
  schema: z.ZodType<Output>,
  input: JsonValue,
  code: ProtocolErrorCode,
  label: string,
): Output {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const detail = result.error.issues[0]?.message ?? "is invalid";
  throw new ProtocolError(code, `${label}: ${detail}`);
}

export function parsePreviewJobSubmission(input: JsonValue): PreviewJobSubmission {
  return parseWith(previewJobSubmissionSchema, input, "submission_invalid", "job submission");
}

export function parseExecutorClaim(input: JsonValue): ExecutorClaim {
  return parseWith(executorClaimSchema, input, "request_invalid", "executor claim");
}

export function parseExecutorHeartbeatRequest(input: JsonValue): ExecutorHeartbeatRequest {
  return parseWith(executorHeartbeatRequestSchema, input, "request_invalid", "executor heartbeat");
}

export function parseExecutorCompleteRequest(input: JsonValue): ExecutorCompleteRequest {
  return parseWith(executorCompleteRequestSchema, input, "request_invalid", "executor completion");
}

export function parseExecutorFailRequest(input: JsonValue): ExecutorFailRequest {
  const parsed = parseWith(executorFailRequestSchema, input, "request_invalid", "executor failure");
  const request: ExecutorFailRequest = {
    processingToken: parsed.processingToken,
    retryable: parsed.retryable,
  };
  if (parsed.code !== undefined) request.code = parsed.code;
  return request;
}
