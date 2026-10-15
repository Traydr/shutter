import {
  buildMasterPreviewKey,
  CONTROL_HTTP_ROUTES,
  type JsonValue,
  type OperationalEvent,
  type OptimizeRequest,
  ProtocolError,
  parseOptimizeRequest,
  parseResolveRequest,
  type ResolveRequest,
  validateSourceLocator,
} from "@shutter/protocol";
import type { Context, Hono } from "hono";
import type { ControlEnv, ControlRuntimeConfig } from "./app.js";
import { buildImgproxyRequest, IMGPROXY_REQUEST_TIMEOUT_MS } from "./imgproxy.js";
import { bearerCheck } from "./origin-auth.js";
import { RESOLVE_LIFETIME_SECONDS, type Resolution } from "./source-resolvers.js";
import type { ActiveResolverRead, SpaceRegistry } from "./spaces/registry.js";

type ControlApp = Hono<ControlEnv>;

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

/**
 * An optimize request and how to settle its source. A `master` input names
 * the kind for the request's completion and failure events; a `resolved` one
 * names the resolver whose credential is read with the policy.
 */
interface OptimizeDelegation extends OptimizeRequest {
  /**
   * Resolves the imgproxy source once the active policy is known. Answering
   * with a Response ends the request (a locator outside the allowlist, for
   * example); throwing is an optimization failure and answers 502.
   */
  sourceUrl(space: ActiveResolverRead): Promise<string | Response>;
}

/**
 * The one registry read an optimization costs: the active policy, with the
 * named resolver's credential in the same statement when there is one.
 */
async function readActiveSpace(
  registry: SpaceRegistry,
  delegation: OptimizeDelegation,
): Promise<ActiveResolverRead | undefined> {
  if (delegation.input.type === "resolved") {
    return registry.getActiveResolverRead({
      spaceId: delegation.spaceId,
      resolverId: delegation.input.resolverId,
    });
  }
  const policy = await registry.getActiveSpacePolicy(delegation.spaceId);

  return policy === undefined ? undefined : { policy, credential: { outcome: "absent" } };
}

/**
 * The one imgproxy delegation: active policy or 404/503, build the signed
 * imgproxy request, fetch with redirects forbidden, then stream the bytes or
 * answer 502 with a `control.optimize.failed` event. A success is recorded by
 * the request's own `control.http.completed` event alone, so an optimization
 * costs one log line. The imgproxy exchange ends when the caller disconnects
 * or after `IMGPROXY_REQUEST_TIMEOUT_MS`, so an abandoned render is not left
 * running. The optimize route parses its tagged input and settles the source
 * URL in front of this.
 */
async function delegateOptimization(
  context: Context<ControlEnv>,
  runtime: ControlRuntimeConfig,
  delegation: OptimizeDelegation,
): Promise<Response> {
  const imgproxy = runtime.imgproxyConfig();
  if (imgproxy === undefined) return failure(503, "service_unavailable");
  if (runtime.spaceRegistry === undefined) return failure(503, "service_unavailable");

  let space: ActiveResolverRead | undefined;
  try {
    space = await readActiveSpace(runtime.spaceRegistry, delegation);
  } catch {
    return failure(503, "service_unavailable");
  }
  if (space === undefined) return failure(404, "not_found");
  if (delegation.input.type === "master") context.set("previewKind", delegation.input.kind);

  try {
    const sourceUrl = await delegation.sourceUrl(space);
    if (sourceUrl instanceof Response) return sourceUrl;
    const request = buildImgproxyRequest(
      { sourceUrl, width: delegation.width, quality: delegation.quality },
      imgproxy,
    );
    const send = runtime.imgproxyFetch ?? runtime.fetch;
    const response = await send(request.url, {
      headers: request.headers,
      redirect: "error",
      signal: AbortSignal.any([
        context.req.raw.signal,
        AbortSignal.timeout(IMGPROXY_REQUEST_TIMEOUT_MS),
      ]),
    });
    if (!response.ok || response.body === null) throw new Error("optimization failed");
    const headers = new Headers({
      ...NO_STORE,
      "content-type": response.headers.get("content-type") ?? "image/webp",
    });
    // The length describes the bytes on the wire; a decoded body has no
    // length to forward, so it stays chunked.
    const length = response.headers.get("content-length");
    if (length !== null && response.headers.get("content-encoding") === null) {
      headers.set("content-length", length);
    }

    return new Response(response.body, { status: 200, headers });
  } catch {
    const event: OperationalEvent = {
      event: "control.optimize.failed",
      outcome: "failed",
      failureCode: "service_unavailable",
    };
    if (delegation.input.type === "master") event.kind = delegation.input.kind;
    runtime.logger.emit("error", event);

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
  const authorizedOrigin = bearerCheck(() => runtime.originAuthToken());

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
      ...request,
      async sourceUrl({ policy, credential }) {
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
              credential,
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
    return delegateOptimization(context, runtime, delegation);
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
    let space: ActiveResolverRead | undefined;
    try {
      space = await runtime.spaceRegistry.getActiveResolverRead(request);
    } catch {
      return failure(503, "service_unavailable");
    }
    if (space === undefined) return failure(404, "not_found");
    let resolution: Resolution;
    try {
      resolution = await resolvers.resolve({
        policy: space.policy,
        credential: space.credential,
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
