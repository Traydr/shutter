import { Effect, Schema } from "effect";
import { SubmissionError } from "./errors.js";
import type {
  ExecutorClaim,
  ExecutorCompleteRequest,
  ExecutorFailRequest,
  ExecutorHeartbeatRequest,
  PreviewJobSubmission,
} from "./types.js";

export { createFailedJobRepresentation } from "./job-representation.js";
export type {
  ExecutorClaim,
  ExecutorCompleteRequest,
  ExecutorFailRequest,
  ExecutorHeartbeatRequest,
  PreviewJobSubmission,
} from "./types.js";

const RenditionKindSchema = Schema.Literals(["video", "pdf"]);
const JobFailureCodeSchema = Schema.Literals([
  "source_expired",
  "attempts_exhausted",
  "source_missing",
  "unsupported_media",
  "source_too_large",
  "source_corrupt",
  "pdf_password_protected",
  "configuration_error",
  "internal_invariant",
]);

const PreviewJobSubmissionSchema = Schema.Struct({
  sourceCapability: Schema.NonEmptyString,
});

const ExecutorClaimSchema = Schema.Struct({
  spaceId: Schema.NonEmptyString,
  sourceId: Schema.NonEmptyString,
  kind: RenditionKindSchema,
  locator: Schema.NonEmptyString,
  outputKey: Schema.NonEmptyString,
  processingToken: Schema.NonEmptyString,
  executionCycle: Schema.Int,
  attemptNumber: Schema.Int,
});

const ExecutorHeartbeatRequestSchema = Schema.Struct({
  processingToken: Schema.NonEmptyString,
});

const ExecutorCompleteRequestSchema = Schema.Struct({
  processingToken: Schema.NonEmptyString,
  masterKey: Schema.NonEmptyString,
  width: Schema.Int,
  height: Schema.Int,
  format: Schema.Literal("webp"),
  objectEtag: Schema.String,
});

const ExecutorFailRequestSchema = Schema.Struct({
  processingToken: Schema.NonEmptyString,
  retryable: Schema.Boolean,
  code: Schema.optionalKey(JobFailureCodeSchema),
});

const strictDecode = { onExcessProperty: "error" } as const;

function decodeSubmission<Output>(
  schema: Schema.Codec<Output, unknown, never, never>,
  input: unknown,
  code: "submission_invalid" | "request_invalid",
  message: string,
): Effect.Effect<Output, SubmissionError> {
  return Schema.decodeUnknownEffect(
    schema,
    strictDecode,
  )(input).pipe(Effect.mapError(() => new SubmissionError({ code, message })));
}

export function parsePreviewJobSubmission(
  input: unknown,
): Effect.Effect<PreviewJobSubmission, SubmissionError> {
  return decodeSubmission(
    PreviewJobSubmissionSchema,
    input,
    "submission_invalid",
    "job submission must contain only a non-empty sourceCapability",
  );
}

export function parseExecutorClaim(input: unknown): Effect.Effect<ExecutorClaim, SubmissionError> {
  return decodeSubmission(
    ExecutorClaimSchema,
    input,
    "request_invalid",
    "executor claim is invalid",
  );
}

export function parseExecutorHeartbeatRequest(
  input: unknown,
): Effect.Effect<ExecutorHeartbeatRequest, SubmissionError> {
  return decodeSubmission(
    ExecutorHeartbeatRequestSchema,
    input,
    "request_invalid",
    "executor heartbeat is invalid",
  );
}

export function parseExecutorCompleteRequest(
  input: unknown,
): Effect.Effect<ExecutorCompleteRequest, SubmissionError> {
  return decodeSubmission(
    ExecutorCompleteRequestSchema,
    input,
    "request_invalid",
    "executor completion is invalid",
  );
}

export function parseExecutorFailRequest(
  input: unknown,
): Effect.Effect<ExecutorFailRequest, SubmissionError> {
  return decodeSubmission(
    ExecutorFailRequestSchema,
    input,
    "request_invalid",
    "executor failure is invalid",
  );
}
