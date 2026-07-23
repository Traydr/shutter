import { sourceFingerprint } from "./cache-identity.js";
import {
  FAILURE_ACTIONS,
  type JobFailureCode,
  type RenditionKind,
  type RouteClass,
} from "./types.js";

export const OPERATIONAL_EVENT_NAMES = [
  "edge.rendition",
  "edge.failure",
  "control.job.submitted",
  "control.dispatch.failed",
  "control.executor.delegated",
  "control.job.completed",
  "control.job.failed",
  "control.purge.completed",
  "control.purge.failed",
  "control.recovery.completed",
  "control.recovery.failed",
  "control.http.completed",
  "control.rendition.failed",
  "control.rendition.delegated",
  "control.service.started",
  "control.service.stopping",
  "control.service.failed",
  "control.telemetry.configuration_failed",
  "control.telemetry.export_failed",
  "executor.claimed",
  "executor.completed",
  "executor.stale_completion",
  "executor.failed",
] as const;

export type OperationalEventName = (typeof OPERATIONAL_EVENT_NAMES)[number];

export interface OperationalEventFields {
  routeClass?: RouteClass;
  cacheOutcome?: "edge-hit" | "r2-hit" | "origin";
  kind?: RenditionKind;
  executionCycle?: number;
  attemptNumber?: number;
  durationMs?: number;
  outcome?: "accepted" | "ready" | "failed" | "idle" | "busy";
  failureCode?: JobFailureCode | "service_unavailable" | "stale_attempt";
  count?: number;
  requestId?: string;
  httpMethod?: string;
  httpRoute?: string;
  httpStatusCode?: number;
  errorType?: string;
}

export interface OperationalEvent extends OperationalEventFields {
  event: OperationalEventName;
  sourceHash?: string;
  processingTokenHash?: string;
}

const EVENT_NAMES = new Set<string>(OPERATIONAL_EVENT_NAMES);
const FAILURE_CODES = new Set<string>([
  ...Object.keys(FAILURE_ACTIONS),
  "service_unavailable",
  "stale_attempt",
]);
const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const HASH = /^[A-Za-z0-9_-]{43}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HTTP_METHOD = /^[A-Z]{1,16}$/u;
const HTTP_ROUTE = /^\/[A-Za-z0-9_./:*-]{0,255}$/u;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function operationalErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "NonErrorThrown";
  return ERROR_TYPE.test(error.name) ? error.name : "Error";
}

export function sanitizeOperationalEvent(event: OperationalEvent): OperationalEvent {
  const candidate = event as unknown as Record<string, unknown>;
  const eventName = candidate.event;
  if (typeof eventName !== "string" || !EVENT_NAMES.has(eventName)) {
    return {
      event: "control.service.failed",
      outcome: "failed",
      failureCode: "service_unavailable",
      errorType: "OperationalEventValidationError",
    };
  }

  const sanitized: OperationalEvent = { event: eventName as OperationalEventName };
  if (typeof candidate.sourceHash === "string" && HASH.test(candidate.sourceHash))
    sanitized.sourceHash = candidate.sourceHash;
  if (typeof candidate.processingTokenHash === "string" && HASH.test(candidate.processingTokenHash))
    sanitized.processingTokenHash = candidate.processingTokenHash;
  if (candidate.routeClass === "public" || candidate.routeClass === "private")
    sanitized.routeClass = candidate.routeClass;
  if (
    candidate.cacheOutcome === "edge-hit" ||
    candidate.cacheOutcome === "r2-hit" ||
    candidate.cacheOutcome === "origin"
  )
    sanitized.cacheOutcome = candidate.cacheOutcome;
  if (candidate.kind === "video" || candidate.kind === "pdf") sanitized.kind = candidate.kind;
  if (isNonNegativeInteger(candidate.executionCycle))
    sanitized.executionCycle = candidate.executionCycle;
  if (isNonNegativeInteger(candidate.attemptNumber))
    sanitized.attemptNumber = candidate.attemptNumber;
  if (isNonNegativeNumber(candidate.durationMs)) sanitized.durationMs = candidate.durationMs;
  if (
    candidate.outcome === "accepted" ||
    candidate.outcome === "ready" ||
    candidate.outcome === "failed" ||
    candidate.outcome === "idle" ||
    candidate.outcome === "busy"
  )
    sanitized.outcome = candidate.outcome;
  if (typeof candidate.failureCode === "string" && FAILURE_CODES.has(candidate.failureCode))
    sanitized.failureCode = candidate.failureCode as NonNullable<
      OperationalEventFields["failureCode"]
    >;
  if (isNonNegativeInteger(candidate.count)) sanitized.count = candidate.count;
  if (typeof candidate.requestId === "string" && REQUEST_ID.test(candidate.requestId))
    sanitized.requestId = candidate.requestId;
  if (typeof candidate.httpMethod === "string" && HTTP_METHOD.test(candidate.httpMethod))
    sanitized.httpMethod = candidate.httpMethod;
  if (
    typeof candidate.httpRoute === "string" &&
    (candidate.httpRoute === "<unmatched>" || HTTP_ROUTE.test(candidate.httpRoute))
  )
    sanitized.httpRoute = candidate.httpRoute;
  if (
    typeof candidate.httpStatusCode === "number" &&
    Number.isInteger(candidate.httpStatusCode) &&
    candidate.httpStatusCode >= 100 &&
    candidate.httpStatusCode <= 599
  )
    sanitized.httpStatusCode = candidate.httpStatusCode;
  if (typeof candidate.errorType === "string" && ERROR_TYPE.test(candidate.errorType))
    sanitized.errorType = candidate.errorType;
  return sanitized;
}

export async function operationalEvent(input: {
  event: OperationalEventName;
  spaceId?: string;
  sourceId?: string;
  processingToken?: string;
  fields?: OperationalEventFields;
}): Promise<OperationalEvent> {
  return sanitizeOperationalEvent({
    event: input.event,
    ...(input.spaceId === undefined || input.sourceId === undefined
      ? {}
      : { sourceHash: await sourceFingerprint(input.spaceId, input.sourceId) }),
    ...(input.processingToken === undefined
      ? {}
      : {
          processingTokenHash: await sourceFingerprint("processing-token", input.processingToken),
        }),
    ...input.fields,
  });
}

export function emitOperationalEvent(level: "info" | "error", event: OperationalEvent): void {
  console[level](sanitizeOperationalEvent(event));
}
