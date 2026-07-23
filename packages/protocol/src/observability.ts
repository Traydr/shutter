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
const HTTP_ROUTE_TEMPLATE =
  /^\/(?:[A-Za-z0-9_.-]+|:[A-Za-z][A-Za-z0-9_]*|\*)(?:\/(?:[A-Za-z0-9_.-]+|:[A-Za-z][A-Za-z0-9_]*|\*))*$/u;
const HTTP_ROUTE_PARAMETER = /^:[A-Za-z][A-Za-z0-9_]*$/u;
const STATIC_HTTP_ROUTES = new Set([
  "/healthz",
  "/internal/v1/master-rendition",
  "/internal/v1/spike/rendition",
]);

type OptionalOperationalEventField = Exclude<keyof OperationalEvent, "event">;
type FieldSanitizers = {
  [Field in OptionalOperationalEventField]-?: (
    value: unknown,
  ) => OperationalEvent[Field] | undefined;
};

function oneOf<const Values extends readonly string[]>(
  ...values: Values
): (value: unknown) => Values[number] | undefined {
  const allowed = new Set<string>(values);
  return (value) =>
    typeof value === "string" && allowed.has(value) ? (value as Values[number]) : undefined;
}

function matching(pattern: RegExp): (value: unknown) => string | undefined {
  return (value) => (typeof value === "string" && pattern.test(value) ? value : undefined);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeHttpRoute(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "<unmatched>" || STATIC_HTTP_ROUTES.has(value)) return value;
  if (!HTTP_ROUTE_TEMPLATE.test(value)) return undefined;
  return value
    .slice(1)
    .split("/")
    .some((segment) => segment === "*" || HTTP_ROUTE_PARAMETER.test(segment))
    ? value
    : undefined;
}

const FIELD_SANITIZERS = {
  sourceHash: matching(HASH),
  processingTokenHash: matching(HASH),
  routeClass: oneOf("public", "private"),
  cacheOutcome: oneOf("edge-hit", "r2-hit", "origin"),
  kind: oneOf("video", "pdf"),
  executionCycle: (value) => (isNonNegativeInteger(value) ? value : undefined),
  attemptNumber: (value) => (isNonNegativeInteger(value) ? value : undefined),
  durationMs: (value) => (isNonNegativeNumber(value) ? value : undefined),
  outcome: oneOf("accepted", "ready", "failed", "idle", "busy"),
  failureCode: (value) =>
    typeof value === "string" && FAILURE_CODES.has(value)
      ? (value as NonNullable<OperationalEventFields["failureCode"]>)
      : undefined,
  count: (value) => (isNonNegativeInteger(value) ? value : undefined),
  requestId: matching(REQUEST_ID),
  httpMethod: matching(HTTP_METHOD),
  httpRoute: safeHttpRoute,
  httpStatusCode: (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
      ? value
      : undefined,
  errorType: matching(ERROR_TYPE),
} satisfies FieldSanitizers;

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

  const sanitizedFields: Partial<Record<OptionalOperationalEventField, string | number>> = {};
  for (const field of Object.keys(FIELD_SANITIZERS) as OptionalOperationalEventField[]) {
    const sanitized = FIELD_SANITIZERS[field](candidate[field]);
    if (sanitized !== undefined) sanitizedFields[field] = sanitized;
  }
  return {
    event: eventName as OperationalEventName,
    ...sanitizedFields,
  } as OperationalEvent;
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
