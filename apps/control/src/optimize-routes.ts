import {
  buildMasterPreviewKey,
  CONTROL_HTTP_ROUTES,
  type JsonValue,
  type OptimizeRequest,
  type PreviewKind,
  ProtocolError,
  parseOptimizeRequest,
  parseResolveRequest,
  type ResolveRequest,
  type SpacePolicy,
  validateSourceLocator,
} from "@shutter/protocol";
import type { Context, Hono } from "hono";
import type { ControlRuntimeConfig } from "./app.js";
import { buildImgproxyRequest } from "./imgproxy.js";
import { bearerAuthorized } from "./origin-auth.js";
import { RESOLVE_LIFETIME_SECONDS, type Resolution } from "./source-resolvers.js";

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
 * answer 502 with the `control.optimize.*` events. The optimize route parses
 * its tagged input and settles the source URL in front of this.
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

async function jsonBody(context: Context): Promise<JsonValue | undefined> {
  try {
    if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      return undefined;
    }
    return await context.req.json();
  } catch {
    return undefined;
  }
}

/** The HTTP answer for every resolution that did not produce a locator. */
function resolutionFailure(resolution: Exclude<Resolution, { outcome: "resolved" }>): Response {
  switch (resolution.outcome) {
    case "not_found":
      return failure(404, "not_found");
    case "not_allowed":
      return failure(403, "locator_not_allowed");
    case "configuration_error":
      return failure(503, "configuration_error");
  }
}

export function registerOptimizeRoutes(app: ControlApp, runtime: ControlRuntimeConfig): void {
  const authorizedOrigin = (header: string | undefined) =>
    bearerAuthorized(header, runtime.originAuthToken());

  // v2: one POST with a tagged input; the locator, when there is one, travels
  // in the body rather than the query string.
  app.post(CONTROL_HTTP_ROUTES.optimize, async (context) => {
    if (!authorizedOrigin(context.req.header("authorization"))) return unauthorized();
    const body = await jsonBody(context);
    if (body === undefined) return failure(400, "request_invalid");
    let request: OptimizeRequest;
    try {
      request = parseOptimizeRequest(body);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      return failure(400, "request_invalid");
    }
    const input = request.input;
    const delegation: OptimizeDelegation = {
      spaceId: request.spaceId,
      width: request.width,
      quality: request.quality,
      async sourceUrl(policy) {
        switch (input.type) {
          case "located":
            try {
              validateSourceLocator(input.sourceUrl, policy.allowedSourceOrigins);
            } catch (error) {
              if (error instanceof ProtocolError) return failure(403, error.code);
              throw error;
            }
            return input.sourceUrl;
          case "master": {
            const masterStore = runtime.masterStore;
            if (masterStore === undefined) return failure(503, "service_unavailable");
            return masterStore.presignGet(
              await buildMasterPreviewKey(request.spaceId, input.sourceId, input.kind),
            );
          }
          case "resolved": {
            const resolvers = runtime.sourceResolvers;
            if (resolvers === undefined) return failure(503, "service_unavailable");
            const resolution = await resolvers.resolve({
              policy,
              resolverId: input.resolverId,
              reference: input.reference,
              lifetimeSeconds: RESOLVE_LIFETIME_SECONDS,
              now: new Date(),
            });
            return resolution.outcome === "resolved"
              ? resolution.locator
              : resolutionFailure(resolution);
          }
        }
      },
    };
    if (input.type === "master") delegation.kind = input.kind;
    return delegateOptimization(runtime, delegation);
  });

  // The Edge asks for a presigned locator on a cold Source Delivery miss of an
  // S3 reference. Templates are answered too, so one wire serves any kind.
  app.post(CONTROL_HTTP_ROUTES.resolve, async (context) => {
    if (!authorizedOrigin(context.req.header("authorization"))) return unauthorized();
    const body = await jsonBody(context);
    if (body === undefined) return failure(400, "request_invalid");
    let request: ResolveRequest;
    try {
      request = parseResolveRequest(body);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      return failure(400, "request_invalid");
    }
    const resolvers = runtime.sourceResolvers;
    if (resolvers === undefined || runtime.spaceRegistry === undefined) {
      return failure(503, "service_unavailable");
    }
    let policy: SpacePolicy | undefined;
    try {
      policy = await runtime.spaceRegistry.getActiveSpacePolicy(request.spaceId);
    } catch {
      return failure(503, "service_unavailable");
    }
    if (policy === undefined) return failure(404, "not_found");
    let resolution: Resolution;
    try {
      resolution = await resolvers.resolve({
        policy,
        resolverId: request.resolverId,
        reference: request.reference,
        lifetimeSeconds: RESOLVE_LIFETIME_SECONDS,
        now: new Date(),
      });
    } catch {
      return failure(503, "service_unavailable");
    }
    if (resolution.outcome !== "resolved") return resolutionFailure(resolution);
    return Response.json(
      { locator: resolution.locator, expiresAt: resolution.expiresAt.toISOString() },
      { status: 200, headers: NO_STORE },
    );
  });
}
