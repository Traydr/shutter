import {
  buildMasterPreviewKey,
  CONTROL_HTTP_ROUTES,
  type JsonValue,
  type OptimizeSourceQuery,
  type PreviewKind,
  ProtocolError,
  parseOptimizeSourceQuery,
  type SpacePolicy,
  validateSourceLocator,
} from "@shutter/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import type { ControlRuntimeConfig } from "./app.js";
import { buildImgproxyRequest } from "./imgproxy.js";
import { bearerAuthorized } from "./origin-auth.js";

type ControlApp = Hono<{ Variables: { requestId: string } }>;

const NO_STORE = { "cache-control": "private, no-store" } as const;

function failure(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status, headers: NO_STORE });
}

function unauthorized(): Response {
  return Response.json(
    { error: { code: "unauthorized" } },
    { status: 401, headers: { ...NO_STORE, "www-authenticate": "Bearer" } },
  );
}

interface OptimizeDelegation {
  spaceId: string;
  width: number;
  quality: number;
  /** Master routes name a kind for the `control.optimize.*` events. */
  kind?: PreviewKind;
  /**
   * Resolves the imgproxy source once the active policy is known. Answering
   * with a Response ends the request (a locator outside the allowlist, for
   * example); throwing is an optimization failure and answers 502.
   */
  sourceUrl(policy: SpacePolicy): Promise<string | Response>;
}

/**
 * The one imgproxy delegation: active policy or 404/503, build the signed
 * imgproxy request, fetch with redirects forbidden, then stream the bytes or
 * answer 502 with the `control.optimize.*` events. Both optimize routes are a
 * parse step in front of this.
 */
async function delegateOptimization(
  runtime: ControlRuntimeConfig,
  delegation: OptimizeDelegation,
): Promise<Response> {
  const imgproxy = runtime.imgproxyConfig();
  if (imgproxy === undefined) return failure(503, "service_unavailable");
  if (runtime.spaceRegistry === undefined) return failure(503, "service_unavailable");

  let policy: SpacePolicy | undefined;
  try {
    policy = await runtime.spaceRegistry.getActiveSpacePolicy(delegation.spaceId);
  } catch {
    return failure(503, "service_unavailable");
  }
  if (policy === undefined) return failure(404, "not_found");

  const eventKind = delegation.kind === undefined ? {} : { kind: delegation.kind };
  try {
    const sourceUrl = await delegation.sourceUrl(policy);
    if (sourceUrl instanceof Response) return sourceUrl;
    const request = buildImgproxyRequest(
      { sourceUrl, width: delegation.width, quality: delegation.quality },
      imgproxy,
    );
    runtime.logger.emit("info", {
      event: "control.optimize.delegated",
      ...eventKind,
      outcome: "accepted",
    });
    const response = await runtime.fetch(request.url, {
      headers: request.headers,
      redirect: "error",
    });
    if (!response.ok || response.body === null) throw new Error("optimization failed");
    runtime.logger.emit("info", {
      event: "control.optimize.delegated",
      ...eventKind,
      outcome: "ready",
    });
    return new Response(response.body, {
      status: 200,
      headers: {
        ...NO_STORE,
        "content-type": response.headers.get("content-type") ?? "image/webp",
      },
    });
  } catch {
    runtime.logger.emit("error", {
      event: "control.optimize.failed",
      ...eventKind,
      outcome: "failed",
      failureCode: "service_unavailable",
    });
    return failure(502, "optimization_failed");
  }
}

/**
 * The master route's body validation stays local until a second consumer
 * appears; the source route's query already parses through the protocol.
 */
const optimizeMasterBodySchema = z
  .strictObject({
    spaceId: z.string(),
    sourceId: z.string(),
    kind: z.enum(["video", "pdf"]),
    w: z.int().positive(),
    q: z.int().min(1).max(100),
  })
  .transform((body) => ({
    spaceId: body.spaceId,
    sourceId: body.sourceId,
    kind: body.kind,
    width: body.w,
    quality: body.q,
  }));

type OptimizeMasterBody = z.output<typeof optimizeMasterBodySchema>;

function parseOptimizeMasterBody(body: JsonValue): OptimizeMasterBody | undefined {
  const parsed = optimizeMasterBodySchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export function registerOptimizeRoutes(app: ControlApp, runtime: ControlRuntimeConfig): void {
  const authorizedOrigin = (header: string | undefined) =>
    bearerAuthorized(header, runtime.originAuthToken());

  app.get(CONTROL_HTTP_ROUTES.optimizeSource, async (context) => {
    if (!authorizedOrigin(context.req.header("authorization"))) return unauthorized();
    let query: OptimizeSourceQuery;
    try {
      query = parseOptimizeSourceQuery(new URL(context.req.url).searchParams);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      return failure(400, "request_invalid");
    }
    return delegateOptimization(runtime, {
      spaceId: query.spaceId,
      width: query.width,
      quality: query.quality,
      async sourceUrl(policy) {
        try {
          validateSourceLocator(query.sourceUrl, policy.allowedSourceOrigins);
        } catch (error) {
          if (error instanceof ProtocolError) return failure(403, error.code);
          throw error;
        }
        return query.sourceUrl;
      },
    });
  });

  app.post(CONTROL_HTTP_ROUTES.optimizeMaster, async (context) => {
    if (!authorizedOrigin(context.req.header("authorization"))) return unauthorized();
    let body: JsonValue;
    try {
      if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new Error("invalid content type");
      }
      body = await context.req.json();
    } catch {
      return failure(400, "request_invalid");
    }
    const parsed = parseOptimizeMasterBody(body);
    if (parsed === undefined) return failure(400, "request_invalid");
    const masterStore = runtime.masterStore;
    if (masterStore === undefined) return failure(503, "service_unavailable");
    return delegateOptimization(runtime, {
      spaceId: parsed.spaceId,
      width: parsed.width,
      quality: parsed.quality,
      kind: parsed.kind,
      async sourceUrl() {
        const key = await buildMasterPreviewKey(parsed.spaceId, parsed.sourceId, parsed.kind);
        return masterStore.presignGet(key);
      },
    });
  });
}
