import { ProtocolError } from "./errors.js";

export const CONTROL_HTTP_ROUTES = {
  healthz: "/healthz",
  edgeConfig: "/internal/v1/edge/config",
  edgeConfigRefresh: "/internal/v1/edge/config/refresh",
  optimizeMaster: "/internal/v1/optimize-master",
  optimizeSource: "/internal/v1/optimize-source",
  sourcePurge: "/v1/spaces/:spaceId/sources/:sourceId/purge",
  previewJob: "/v1/spaces/:spaceId/sources/:sourceId/previews/:kind",
  executorClaim: "/internal/v1/executors/:kind/claim",
  executorHeartbeat: "/internal/v1/executors/:kind/jobs/:spaceId/:sourceId/heartbeat",
  executorComplete: "/internal/v1/executors/:kind/jobs/:spaceId/:sourceId/complete",
  executorFail: "/internal/v1/executors/:kind/jobs/:spaceId/:sourceId/fail",
} as const;

export type ControlHttpRoute = (typeof CONTROL_HTTP_ROUTES)[keyof typeof CONTROL_HTTP_ROUTES];

/**
 * The query the Edge sends Control on `optimizeSource`: which Space's policy
 * applies, where the Source Object is, and the normalized optimization
 * parameters. Cache identity stays at the Edge; Control never sees a Delivery
 * Cache key.
 */
export interface OptimizeSourceQuery {
  spaceId: string;
  sourceUrl: string;
  width: number;
  quality: number;
}

const OPTIMIZE_SOURCE_PARAMETERS = {
  spaceId: "space",
  sourceUrl: "source",
  width: "w",
  quality: "q",
} as const;

const OPTIMIZE_SOURCE_PARAMETER_NAMES = new Set<string>(Object.values(OPTIMIZE_SOURCE_PARAMETERS));

export function buildOptimizeSourceQuery(query: OptimizeSourceQuery): URLSearchParams {
  const parameters = new URLSearchParams();
  parameters.set(OPTIMIZE_SOURCE_PARAMETERS.spaceId, query.spaceId);
  parameters.set(OPTIMIZE_SOURCE_PARAMETERS.sourceUrl, query.sourceUrl);
  parameters.set(OPTIMIZE_SOURCE_PARAMETERS.width, String(query.width));
  parameters.set(OPTIMIZE_SOURCE_PARAMETERS.quality, String(query.quality));
  return parameters;
}

function requireSingle(parameters: URLSearchParams, name: string): string {
  const values = parameters.getAll(name);
  const value = values[0];
  if (values.length !== 1 || value === undefined || value.length === 0) {
    throw new ProtocolError("request_invalid", `${name} must be supplied exactly once`);
  }
  return value;
}

function positiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new ProtocolError("request_invalid", `${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProtocolError("request_invalid", `${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Accepts exactly the four parameters `buildOptimizeSourceQuery` writes, each
 * once, with strict positive integers and a quality of at most 100. Anything
 * else throws `request_invalid`.
 */
export function parseOptimizeSourceQuery(parameters: URLSearchParams): OptimizeSourceQuery {
  for (const name of parameters.keys()) {
    if (!OPTIMIZE_SOURCE_PARAMETER_NAMES.has(name)) {
      throw new ProtocolError("request_invalid", "unknown optimize-source parameter");
    }
  }
  const spaceId = requireSingle(parameters, OPTIMIZE_SOURCE_PARAMETERS.spaceId);
  const sourceUrl = requireSingle(parameters, OPTIMIZE_SOURCE_PARAMETERS.sourceUrl);
  const width = positiveInteger(
    requireSingle(parameters, OPTIMIZE_SOURCE_PARAMETERS.width),
    OPTIMIZE_SOURCE_PARAMETERS.width,
  );
  const quality = positiveInteger(
    requireSingle(parameters, OPTIMIZE_SOURCE_PARAMETERS.quality),
    OPTIMIZE_SOURCE_PARAMETERS.quality,
  );
  if (quality > 100) {
    throw new ProtocolError("request_invalid", "q must be at most 100");
  }
  return { spaceId, sourceUrl, width, quality };
}
