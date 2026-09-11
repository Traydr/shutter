import {
  CONTROL_HTTP_ROUTES,
  canonicalDeliveryQuery,
  type DeliveryOperation,
  expandPublicResolver,
  parseDeliveryQuery,
  parseResolveResponse,
  parseSourceReference,
  type SourceReference,
  type SourceResolverPolicy,
  validateSourceLocator,
} from "@shutter/protocol";
import type { Context, Hono } from "hono";
import { methodNotAllowed, notFound } from "./http-responses.js";
import { deliverOptimization } from "./optimization-routes.js";
import { deliverSource } from "./source-delivery.js";
import { type SpaceRouteAccess, spaceRoute } from "./space-route.js";

type EdgeEnv = { Bindings: CloudflareBindings };
type EdgeApp = Hono<EdgeEnv>;

/**
 * `/v2/{space}/{resolver}/{reference}`: one route, every operation. The query
 * selects Source Delivery, Image Optimization, or the Master Preview; the
 * resolver and reference name the source (ADR 0026). Private Spaces gain the
 * same route with a token gate in a later PR; until then they answer 404 here.
 */
const V2_ROUTE = "/v2/:spaceId/:resolverId/*";
const V2_METHODS = ["GET", "HEAD"] as const;

/**
 * The reference segments after `/v2/{space}/{resolver}/`, each percent-decoded
 * once. A malformed escape or an empty segment is a 404, like every other
 * resolution failure, so a caller cannot probe the grammar.
 */
function referenceSegments(requestUrl: string): readonly string[] | undefined {
  const encoded = new URL(requestUrl).pathname.split("/").slice(4);
  if (encoded.length === 0) return undefined;
  const segments: string[] = [];
  for (const segment of encoded) {
    if (segment.length === 0) return undefined;
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  return segments;
}

/**
 * Where the Edge fetches Source Delivery bytes from. A public resolver expands
 * here from the snapshot; an S3 resolver's presigned URL comes from Control,
 * which alone holds the credential. Both are re-checked against the Space's
 * allowed origins before use.
 */
async function locateSource(
  bindings: CloudflareBindings,
  access: SpaceRouteAccess,
  resolver: SourceResolverPolicy,
  reference: SourceReference,
): Promise<string> {
  const locator =
    resolver.type === "s3"
      ? await resolveThroughControl(bindings, access.spaceId, resolver.id, reference.values)
      : expandPublicResolver(resolver, reference.values);
  validateSourceLocator(locator, access.policy.allowedSourceOrigins);
  return locator;
}

async function resolveThroughControl(
  bindings: CloudflareBindings,
  spaceId: string,
  resolverId: string,
  reference: readonly string[],
): Promise<string> {
  const response = await fetch(new URL(CONTROL_HTTP_ROUTES.resolve, bindings.ORIGIN_BASE_URL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${bindings.ORIGIN_AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ spaceId, resolverId, reference }),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`origin returned ${response.status}`);
  return parseResolveResponse(await response.json()).locator;
}

function canonicalRedirect(requestUrl: string, operation: DeliveryOperation): Response {
  const canonical = new URL(requestUrl);
  canonical.search = `?${canonicalDeliveryQuery(operation)}`;
  return new Response(null, {
    status: 308,
    headers: { "cache-control": "private, no-store", location: canonical.toString() },
  });
}

async function serveV2(context: Context<EdgeEnv>, access: SpaceRouteAccess): Promise<Response> {
  const resolverId = context.req.param("resolverId") ?? "";
  const resolver = access.policy.resolvers.find((candidate) => candidate.id === resolverId);
  if (resolver === undefined) return notFound();
  const segments = referenceSegments(context.req.url);
  if (segments === undefined) return notFound();
  const reference = parseSourceReference(resolver, segments);
  if (reference === undefined) return notFound();

  const { operation } = parseDeliveryQuery(new URL(context.req.url).searchParams, access.policy, {
    token: "forbidden",
  });
  const identity = { routeClass: access.policy.routeClass, spaceId: access.spaceId };

  if (operation.type === "source_delivery") {
    return deliverSource({
      executionCtx: context.executionCtx,
      request: context.req.raw,
      identity: { ...identity, sourceId: reference.sourceId },
      locate: () => locateSource(context.env, access, resolver, reference),
      apiVersion: "v2",
    });
  }

  // The contract permits HEAD on Source Delivery only; an optimization is
  // refused before any redirect, cache read, or origin render.
  if (context.req.method !== "GET") return methodNotAllowed("GET");
  if (!operation.isCanonical) return canonicalRedirect(context.req.url, operation);
  return deliverOptimization(
    context.env,
    {
      ...identity,
      sourceId: reference.sourceId,
      input:
        operation.type === "master_preview"
          ? { type: "master", kind: operation.kind }
          : { type: "source" },
      width: operation.width,
      quality: operation.quality,
    },
    operation.type === "master_preview"
      ? { type: "master", kind: operation.kind, requireStored: true }
      : { type: "resolved", resolverId: resolver.id, reference: reference.values },
    "v2",
  );
}

/** What the operation named by the query permits: only Source Delivery takes HEAD. */
function allowedMethods(requestUrl: string): string {
  const query = new URL(requestUrl).searchParams;
  return query.has("w") || query.has("preview") ? "GET" : "GET, HEAD";
}

export function registerV2DeliveryRoutes(app: EdgeApp): void {
  spaceRoute(app, { methods: V2_METHODS, path: V2_ROUTE, routeClass: "public" }, serveV2);
  app.all(V2_ROUTE, (context) => methodNotAllowed(allowedMethods(context.req.url)));
}
