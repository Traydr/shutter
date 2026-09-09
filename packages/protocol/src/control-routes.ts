import { z } from "zod";
import { ProtocolError } from "./errors.js";
import type { JsonValue } from "./json.js";
import type { PreviewKind } from "./types.js";

export const CONTROL_HTTP_ROUTES = {
  healthz: "/healthz",
  edgeConfig: "/internal/v1/edge/config",
  edgeConfigRefresh: "/internal/v1/edge/config/refresh",
  optimize: "/internal/v2/optimize",
  resolve: "/internal/v2/resolve",
  sourcePurge: "/v1/spaces/:spaceId/sources/:sourceId/purge",
  previewJob: "/v1/spaces/:spaceId/sources/:sourceId/previews/:kind",
  sourcePurgeV2: "/v2/spaces/:spaceId/sources/:sourceId/purge",
  previewJobV2: "/v2/spaces/:spaceId/sources/:sourceId/previews/:kind",
  executorClaim: "/internal/v1/executors/:kind/claim",
  executorHeartbeat: "/internal/v1/executors/:kind/jobs/:spaceId/:sourceId/heartbeat",
  executorComplete: "/internal/v1/executors/:kind/jobs/:spaceId/:sourceId/complete",
  executorFail: "/internal/v1/executors/:kind/jobs/:spaceId/:sourceId/fail",
} as const;

export type ControlHttpRoute = (typeof CONTROL_HTTP_ROUTES)[keyof typeof CONTROL_HTTP_ROUTES];

// v2 internal wire

/**
 * What Control should optimize: a resolver source it resolves itself, a
 * located source whose locator the Edge already verified (the v1 routes), or
 * a stored Master Preview. Each variant is its own strict schema.
 */
export type OptimizeInput =
  | { type: "resolved"; resolverId: string; reference: readonly string[] }
  | { type: "located"; sourceUrl: string }
  | { type: "master"; sourceId: string; kind: PreviewKind };

export interface OptimizeRequest {
  spaceId: string;
  input: OptimizeInput;
  width: number;
  quality: number;
}

/** A resolver reference the Edge wants presigned for Source Delivery. */
export interface ResolveRequest {
  spaceId: string;
  resolverId: string;
  reference: readonly string[];
}

export interface ResolveResponse {
  locator: string;
  /** ISO timestamp after which the locator must not be used. */
  expiresAt: string;
}

const nonEmpty = z.string().min(1);
const referenceSchema = z.array(nonEmpty).nonempty().readonly();
const previewKindSchema = z.enum(["video", "pdf"]);

const optimizeInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("resolved"), resolverId: nonEmpty, reference: referenceSchema }),
  z.strictObject({ type: z.literal("located"), sourceUrl: nonEmpty }),
  z.strictObject({ type: z.literal("master"), sourceId: nonEmpty, kind: previewKindSchema }),
]);

const optimizeRequestSchema = z.strictObject({
  spaceId: nonEmpty,
  input: optimizeInputSchema,
  width: z.int().positive(),
  quality: z.int().min(1).max(100),
});

const resolveRequestSchema = z.strictObject({
  spaceId: nonEmpty,
  resolverId: nonEmpty,
  reference: referenceSchema,
});

const resolveResponseSchema = z.strictObject({
  locator: nonEmpty,
  expiresAt: z.iso.datetime(),
});

function parseWire<Output>(schema: z.ZodType<Output>, body: JsonValue, label: string): Output {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const detail = result.error.issues[0]?.message ?? "is invalid";
  throw new ProtocolError("request_invalid", `${label}: ${detail}`);
}

export function parseOptimizeRequest(body: JsonValue): OptimizeRequest {
  return parseWire(optimizeRequestSchema, body, "optimize request");
}

export function parseResolveRequest(body: JsonValue): ResolveRequest {
  return parseWire(resolveRequestSchema, body, "resolve request");
}

export function parseResolveResponse(body: JsonValue): ResolveResponse {
  return parseWire(resolveResponseSchema, body, "resolve response");
}
