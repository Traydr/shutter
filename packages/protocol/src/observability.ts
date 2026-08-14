import { sourceFingerprint } from "./cache-identity.js";
import { CONTROL_HTTP_ROUTES, type ControlHttpRoute } from "./control-routes.js";
import {
  FAILURE_ACTIONS,
  type JobFailureCode,
  type PreviewKind,
  type RouteClass,
} from "./types.js";

export const OPERATIONAL_EVENT_NAMES = [
  "edge.delivery",
  "edge.source_delivery",
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
  "control.optimize.failed",
  "control.optimize.delegated",
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
  mediaClass?: "image" | "video" | "pdf";
  byteRangeOutcome?: "none" | "edge-hit" | "origin" | "unsatisfied";
  originFetchResult?:
    | "not-requested"
    | "complete"
    | "partial"
    | "not-modified"
    | "unsatisfied"
    | "rejected"
    | "failed";
  kind?: PreviewKind;
  executionCycle?: number;
  attemptNumber?: number;
  durationMs?: number;
  outcome?: "accepted" | "ready" | "failed" | "idle" | "busy";
  failureCode?: JobFailureCode | "service_unavailable" | "stale_attempt";
  count?: number;
  requestId?: string;
  httpMethod?: string;
  httpRoute?: ControlHttpRoute | "<unmatched>";
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
const CONTROL_HTTP_ROUTE_TEMPLATES = new Set<string>(Object.values(CONTROL_HTTP_ROUTES));

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

function isControlHttpRoute(value: string): value is ControlHttpRoute {
  return CONTROL_HTTP_ROUTE_TEMPLATES.has(value);
}

function safeHttpRoute(value: unknown): ControlHttpRoute | "<unmatched>" | undefined {
  if (value === "<unmatched>") return value;
  return typeof value === "string" && isControlHttpRoute(value) ? value : undefined;
}

const FIELD_SANITIZERS = {
  sourceHash: matching(HASH),
  processingTokenHash: matching(HASH),
  routeClass: oneOf("public", "private"),
  cacheOutcome: oneOf("edge-hit", "r2-hit", "origin"),
  mediaClass: oneOf("image", "video", "pdf"),
  byteRangeOutcome: oneOf("none", "edge-hit", "origin", "unsatisfied"),
  originFetchResult: oneOf(
    "not-requested",
    "complete",
    "partial",
    "not-modified",
    "unsatisfied",
    "rejected",
    "failed",
  ),
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

function setSanitizedField<Field extends OptionalOperationalEventField>(
  event: OperationalEvent,
  field: Field,
  value: NonNullable<OperationalEvent[Field]>,
): void {
  Object.assign(event, { [field]: value });
}

export function sanitizeOperationalEvent(event: unknown): OperationalEvent {
  const candidate =
    typeof event === "object" && event !== null && !Array.isArray(event)
      ? (event as Record<string, unknown>)
      : {};
  const eventName = candidate.event;
  if (typeof eventName !== "string" || !EVENT_NAMES.has(eventName)) {
    return {
      event: "control.service.failed",
      outcome: "failed",
      failureCode: "service_unavailable",
      errorType: "OperationalEventValidationError",
    };
  }

  const sanitizedEvent: OperationalEvent = {
    event: eventName as OperationalEventName,
  };
  for (const field of Object.keys(FIELD_SANITIZERS) as OptionalOperationalEventField[]) {
    const sanitized = FIELD_SANITIZERS[field](candidate[field]);
    if (sanitized !== undefined) setSanitizedField(sanitizedEvent, field, sanitized);
  }
  return sanitizedEvent;
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
