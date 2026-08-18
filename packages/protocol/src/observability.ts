import { z } from "zod";
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
  "control.registry.keys_excluded",
  "control.http.completed",
  "control.optimize.failed",
  "control.optimize.delegated",
  "control.service.started",
  "control.service.features",
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
  /**
   * Optional features a service could not enable at boot, as
   * `feature=VAR,VAR feature=VAR`: each entry names one feature and the
   * environment variables that would enable it. Only identifiers, never values.
   */
  features?: string;
}

export interface OperationalEvent extends OperationalEventFields {
  event: OperationalEventName;
  sourceHash?: string;
  processingTokenHash?: string;
}

const EVENT_NAME_SCHEMA = z.enum(OPERATIONAL_EVENT_NAMES);
const FAILURE_CODES = new Set<string>([
  ...Object.keys(FAILURE_ACTIONS),
  "service_unavailable",
  "stale_attempt",
]);
const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const HASH = /^[A-Za-z0-9_-]{43}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HTTP_METHOD = /^[A-Z]{1,16}$/u;
const FEATURE_ENTRY = "[A-Za-z][A-Za-z0-9]{0,63}=[A-Z][A-Z0-9_]{0,63}(?:,[A-Z][A-Z0-9_]{0,63})*";
const FEATURES = new RegExp(`^${FEATURE_ENTRY}(?: ${FEATURE_ENTRY}){0,31}$`, "u");
const CONTROL_HTTP_ROUTE_TEMPLATES = new Set<string>(Object.values(CONTROL_HTTP_ROUTES));

type OptionalOperationalEventField = Exclude<keyof OperationalEvent, "event">;
type FieldSchemas = {
  [Field in OptionalOperationalEventField]-?: z.ZodType<NonNullable<OperationalEvent[Field]>>;
};

type FailureCodeField = NonNullable<OperationalEventFields["failureCode"]>;
type HttpRouteField = NonNullable<OperationalEventFields["httpRoute"]>;

const nonNegativeInteger = z.int().nonnegative();

/**
 * One schema per allowlisted field. `sanitizeOperationalEvent` keeps a field
 * only when its value parses, so a malformed or unexpected value is dropped
 * rather than logged.
 */
const FIELD_SCHEMAS = {
  sourceHash: z.string().regex(HASH),
  processingTokenHash: z.string().regex(HASH),
  routeClass: z.enum(["public", "private"]),
  cacheOutcome: z.enum(["edge-hit", "r2-hit", "origin"]),
  mediaClass: z.enum(["image", "video", "pdf"]),
  byteRangeOutcome: z.enum(["none", "edge-hit", "origin", "unsatisfied"]),
  originFetchResult: z.enum([
    "not-requested",
    "complete",
    "partial",
    "not-modified",
    "unsatisfied",
    "rejected",
    "failed",
  ]),
  kind: z.enum(["video", "pdf"]),
  executionCycle: nonNegativeInteger,
  attemptNumber: nonNegativeInteger,
  durationMs: z.number().nonnegative(),
  outcome: z.enum(["accepted", "ready", "failed", "idle", "busy"]),
  failureCode: z.string().refine((value): value is FailureCodeField => FAILURE_CODES.has(value)),
  count: nonNegativeInteger,
  requestId: z.string().regex(REQUEST_ID),
  httpMethod: z.string().regex(HTTP_METHOD),
  httpRoute: z
    .string()
    .refine(
      (value): value is HttpRouteField =>
        value === "<unmatched>" || CONTROL_HTTP_ROUTE_TEMPLATES.has(value),
    ),
  httpStatusCode: z.int().min(100).max(599),
  errorType: z.string().regex(ERROR_TYPE),
  features: z.string().regex(FEATURES),
} satisfies FieldSchemas;

function isOptionalEventField(field: string): field is OptionalOperationalEventField {
  return Object.hasOwn(FIELD_SCHEMAS, field);
}

export function operationalErrorType(cause: unknown): string {
  if (!(cause instanceof Error)) return "NonErrorThrown";
  return ERROR_TYPE.test(cause.name) ? cause.name : "Error";
}

/**
 * Reduce an event to its allowlisted, well-formed fields. The parameter is
 * typed, but every value is re-checked at runtime so a field that carries an
 * unexpected value never reaches a log sink.
 */
export function sanitizeOperationalEvent(event: OperationalEvent): OperationalEvent {
  const eventName = EVENT_NAME_SCHEMA.safeParse(event.event);
  if (!eventName.success) {
    return {
      event: "control.service.failed",
      outcome: "failed",
      failureCode: "service_unavailable",
      errorType: "OperationalEventValidationError",
    };
  }

  const sanitizedEvent: OperationalEvent = { event: eventName.data };
  for (const [field, candidate] of Object.entries(event)) {
    if (!isOptionalEventField(field)) continue;
    const value = FIELD_SCHEMAS[field].safeParse(candidate);
    if (value.success) Object.assign(sanitizedEvent, { [field]: value.data });
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
  const event: OperationalEvent = { ...input.fields, event: input.event };
  if (input.spaceId !== undefined && input.sourceId !== undefined) {
    event.sourceHash = await sourceFingerprint(input.spaceId, input.sourceId);
  }
  if (input.processingToken !== undefined) {
    event.processingTokenHash = await sourceFingerprint("processing-token", input.processingToken);
  }
  return sanitizeOperationalEvent(event);
}

export function emitOperationalEvent(level: "info" | "error", event: OperationalEvent): void {
  console[level](sanitizeOperationalEvent(event));
}
