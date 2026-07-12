import { sourceFingerprint } from "./cache-identity.js";
import type { JobFailureCode, RenditionKind, RouteClass } from "./types.js";

export type OperationalEventName =
  | "edge.rendition"
  | "edge.failure"
  | "control.job.submitted"
  | "control.dispatch.failed"
  | "control.executor.delegated"
  | "control.job.completed"
  | "control.job.failed"
  | "control.purge.completed"
  | "control.purge.failed"
  | "control.recovery.completed"
  | "control.recovery.failed"
  | "control.rendition.failed"
  | "control.rendition.delegated"
  | "control.service.failed"
  | "executor.claimed"
  | "executor.completed"
  | "executor.stale_completion"
  | "executor.failed";

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
}

export interface OperationalEvent extends OperationalEventFields {
  event: OperationalEventName;
  sourceHash?: string;
  processingTokenHash?: string;
}

export async function operationalEvent(input: {
  event: OperationalEventName;
  spaceId?: string;
  sourceId?: string;
  processingToken?: string;
  fields?: OperationalEventFields;
}): Promise<OperationalEvent> {
  return {
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
  };
}

export function emitOperationalEvent(level: "info" | "error", event: OperationalEvent): void {
  console[level](event);
}
