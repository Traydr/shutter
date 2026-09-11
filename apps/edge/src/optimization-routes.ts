import {
  buildCanonicalCacheUrl,
  buildMasterPreviewKey,
  buildOptimizeSourceQuery,
  buildR2CacheKey,
  buildSourceCacheTag,
  CONTROL_HTTP_ROUTES,
  emitOperationalEvent,
  normalizeOptimizationQuery,
  type OptimizationCacheIdentity,
  type OptimizationInput,
  operationalEvent,
  type PreviewKind,
  verifySourceCapability,
} from "@shutter/protocol";
import type { Context, Hono } from "hono";
import { edgeBrowserResponse, internalEdgeCacheResponse } from "./edge-cache-policy.js";
import { notFound } from "./http-responses.js";
import { type SpaceRouteAccess, spaceRoute } from "./space-route.js";

type EdgeEnv = { Bindings: CloudflareBindings };
type EdgeApp = Hono<EdgeEnv>;

const PUBLIC_LOCATED_ROUTE = "/v1/public/:spaceId/located/:sourceId/:capability";
const PUBLIC_MASTER_ROUTE = "/v1/public/:spaceId/master/:kind/:sourceId";
const PRIVATE_SOURCE_ROUTE = "/v1/private/:spaceId/source/:capability";
const PRIVATE_MASTER_ROUTE = "/v1/private/:spaceId/master/:capability";
const OPTIMIZATION_METHODS = ["GET"] as const;

/**
 * What Control optimizes on a miss: a Source Object the origin fetches from a
 * locator, a resolver source Control resolves itself (the v2 routes), or a
 * stored Master Preview addressed by kind. The locator is resolved only when
 * the origin must be fetched, so a route may defer work (such as verifying a
 * capability) until then.
 */
export type OptimizationOrigin =
  | { type: "source"; locate(): Promise<string> }
  | { type: "resolved"; resolverId: string; reference: readonly string[] }
  | {
      type: "master";
      kind: PreviewKind;
      /**
       * Answer 404 when the Master Store has no object, instead of asking
       * Control to render one that does not exist. The v2 contract requires it;
       * the v1 master routes keep their origin-failure behaviour.
       */
      requireStored?: boolean;
    };

/** Which Delivery URL grammar a request used, for the `edge.delivery` event. */
type ApiVersion = "v1" | "v2";

/** What one Image Optimization is about: the Source ID and where its bytes come from. */
interface OptimizationSubject {
  sourceId: string;
  origin: OptimizationOrigin;
}

function inputOf(origin: OptimizationOrigin): OptimizationInput {
  return origin.type === "master" ? { type: "master", kind: origin.kind } : { type: "source" };
}

/**
 * When a route verifies its Source Capability relative to the cache lookup.
 *
 * - `before` — private routes. The capability is verified before the canonical
 *   redirect and before any cache read, and its claims are the subject: a
 *   private URL never serves bytes, cached or not, without a valid capability.
 * - `on-miss` — the public located route. The Source ID is in the clear path,
 *   and a public URL is cacheable by anyone who holds it: a hit is served
 *   without verification, and the capability is checked only before Shutter
 *   fetches the application-owned Source Object. That keeps an encrypted
 *   presigned locator out of the canonical CDN cache key (ADR 0015).
 * - `none` — the public resolver and public master routes carry no capability.
 */
type CapabilityGate =
  | { verify: "before"; subject(): Promise<OptimizationSubject> }
  | { verify: "on-miss"; sourceId: string; locate(): Promise<string> }
  | { verify: "none"; subject: OptimizationSubject };

async function emitDeliveryEvent(
  identity: OptimizationCacheIdentity,
  cacheOutcome: "edge-hit" | "r2-hit" | "origin",
  apiVersion: ApiVersion,
): Promise<void> {
  emitOperationalEvent(
    "info",
    await operationalEvent({
      event: "edge.delivery",
      spaceId: identity.spaceId,
      sourceId: identity.sourceId,
      fields:
        identity.input.type === "master"
          ? { routeClass: identity.routeClass, apiVersion, cacheOutcome, kind: identity.input.kind }
          : { routeClass: identity.routeClass, apiVersion, cacheOutcome },
    }),
  );
}

function canonicalRedirect(requestUrl: string, width: number, quality: number): Response {
  const canonical = new URL(requestUrl);
  canonical.search = `?w=${width}&q=${quality}`;
  return new Response(null, {
    status: 308,
    headers: { "cache-control": "private, no-store", location: canonical.toString() },
  });
}

async function readR2Response(bucket: R2Bucket, key: string): Promise<Response | undefined> {
  const object = await bucket.get(key);
  if (object === null) return undefined;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (object.httpEtag !== undefined) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function fetchOrigin(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  sourceUrl: string,
): Promise<Response> {
  const originUrl = new URL(CONTROL_HTTP_ROUTES.optimizeSource, bindings.ORIGIN_BASE_URL);
  originUrl.search = buildOptimizeSourceQuery({
    spaceId: identity.spaceId,
    sourceUrl,
    width: identity.width,
    quality: identity.quality,
  }).toString();
  const response = await fetch(originUrl, {
    headers: { authorization: `Bearer ${bindings.ORIGIN_AUTH_TOKEN}` },
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Error(`origin returned ${response.status}`);
  }
  return response;
}

/** The v2 optimize wire: Control resolves the reference itself, so no locator crosses. */
async function fetchResolvedOrigin(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  origin: { resolverId: string; reference: readonly string[] },
): Promise<Response> {
  const response = await fetch(new URL(CONTROL_HTTP_ROUTES.optimize, bindings.ORIGIN_BASE_URL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${bindings.ORIGIN_AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: identity.spaceId,
      input: { type: "resolved", resolverId: origin.resolverId, reference: origin.reference },
      width: identity.width,
      quality: identity.quality,
    }),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`origin returned ${response.status}`);
  return response;
}

async function fetchMasterOrigin(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  kind: PreviewKind,
): Promise<Response> {
  const response = await fetch(
    new URL(CONTROL_HTTP_ROUTES.optimizeMaster, bindings.ORIGIN_BASE_URL),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bindings.ORIGIN_AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spaceId: identity.spaceId,
        sourceId: identity.sourceId,
        kind,
        w: identity.width,
        q: identity.quality,
      }),
      redirect: "manual",
    },
  );
  if (!response.ok) throw new Error(`origin returned ${response.status}`);
  return response;
}

/** Renders at the origin; `undefined` means the Master Preview the request named does not exist. */
async function renderAtOrigin(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  origin: OptimizationOrigin,
): Promise<Response | undefined> {
  switch (origin.type) {
    case "master": {
      if (origin.requireStored === true) {
        const masterKey = await buildMasterPreviewKey(
          identity.spaceId,
          identity.sourceId,
          origin.kind,
        );
        if ((await bindings.MEDIA_STORE.head(masterKey)) === null) return undefined;
      }
      return fetchMasterOrigin(bindings, identity, origin.kind);
    }
    case "resolved":
      return fetchResolvedOrigin(bindings, identity, origin);
    case "source":
      return fetchOrigin(bindings, identity, await origin.locate());
  }
}

async function populateCaches(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  cacheTag: string,
  origin: OptimizationOrigin,
): Promise<Response | undefined> {
  const key = await buildR2CacheKey(identity);
  const rendered = await renderAtOrigin(bindings, identity, origin);
  if (rendered === undefined) return undefined;
  const bytes = await rendered.arrayBuffer();
  const contentType = rendered.headers.get("content-type") ?? "application/octet-stream";
  await bindings.MEDIA_STORE.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { cacheTag },
  });
  return new Response(bytes, { headers: { "content-type": contentType } });
}

/**
 * Delivers one Image Optimization under one cache identity: the Edge cache,
 * then R2, then the origin. Every optimization route, v1 or v2, ends here
 * after it has settled its subject and canonical parameters.
 */
export async function deliverOptimization(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  origin: OptimizationOrigin,
  apiVersion: ApiVersion,
): Promise<Response> {
  const canonicalUrl = await buildCanonicalCacheUrl(identity);
  const cacheKey = new Request(canonicalUrl);
  const cacheTag = await buildSourceCacheTag(identity.spaceId, identity.sourceId);
  const cached = await caches.default.match(cacheKey);
  if (cached !== undefined) {
    await emitDeliveryEvent(identity, "edge-hit", apiVersion);
    return edgeBrowserResponse(cached, {
      routeClass: identity.routeClass,
      cacheStatus: "edge-hit",
      cacheTag,
    });
  }

  const key = await buildR2CacheKey(identity);
  const stored = await readR2Response(bindings.MEDIA_STORE, key);
  let response = stored;
  if (response === undefined) {
    response = await populateCaches(bindings, identity, cacheTag, origin);
    if (response === undefined) return notFound();
  }
  const outcome = stored === undefined ? "origin" : "r2-hit";

  const internal = internalEdgeCacheResponse(response, identity.routeClass, cacheTag);
  await caches.default.put(cacheKey, internal.clone());
  await emitDeliveryEvent(identity, outcome, apiVersion);
  return edgeBrowserResponse(internal, {
    routeClass: identity.routeClass,
    cacheStatus: outcome,
    cacheTag,
  });
}

/**
 * The one prologue of every optimization route: normalize the query, resolve
 * the subject through the route's capability gate, redirect a non-canonical
 * URL, then deliver under one cache identity. The gate decides whether the
 * subject (and so the capability check) is resolved before or after the
 * redirect and cache lookup; nothing else differs between the five routes.
 */
async function optimize(
  context: Context<EdgeEnv>,
  access: SpaceRouteAccess,
  gate: CapabilityGate,
): Promise<Response> {
  const query = normalizeOptimizationQuery(new URL(context.req.url).searchParams, access.policy);
  const subject = await resolveSubject(gate);
  if (!query.isCanonical) return canonicalRedirect(context.req.url, query.width, query.quality);
  const identity: OptimizationCacheIdentity = {
    // spaceRoute already enforced that the Space's route class matches the
    // registered route, so cache identity and response policy read it from
    // the same verified policy rather than a second copy per route.
    routeClass: access.policy.routeClass,
    spaceId: access.spaceId,
    sourceId: subject.sourceId,
    input: inputOf(subject.origin),
    width: query.width,
    quality: query.quality,
  };
  return deliverOptimization(context.env, identity, subject.origin, "v1");
}

function resolveSubject(gate: CapabilityGate): Promise<OptimizationSubject> {
  switch (gate.verify) {
    case "before":
      return gate.subject();
    case "on-miss":
      return Promise.resolve({
        sourceId: gate.sourceId,
        origin: { type: "source", locate: gate.locate },
      });
    case "none":
      return Promise.resolve(gate.subject);
  }
}

export function registerOptimizationRoutes(app: EdgeApp): void {
  spaceRoute(
    app,
    { methods: OPTIMIZATION_METHODS, path: PUBLIC_LOCATED_ROUTE, routeClass: "public" },
    async (context, access) => {
      const sourceId = context.req.param("sourceId") ?? "";
      const capability = context.req.param("capability") ?? "";
      return optimize(context, access, {
        verify: "on-miss",
        sourceId,
        async locate() {
          const claims = await verifySourceCapability(capability, {
            spaceId: access.spaceId,
            expectedPurpose: "image_source",
            expectedSourceId: sourceId,
            keys: access.snapshot.keysFor(access.spaceId),
            now: Math.floor(Date.now() / 1000),
            allowedSourceOrigins: access.policy.allowedSourceOrigins,
          });
          return claims.locator;
        },
      });
    },
  );

  spaceRoute(
    app,
    { methods: OPTIMIZATION_METHODS, path: PUBLIC_MASTER_ROUTE, routeClass: "public" },
    async (context, access) => {
      const kind = context.req.param("kind") ?? "";
      if (kind !== "video" && kind !== "pdf") return notFound();
      return optimize(context, access, {
        verify: "none",
        subject: {
          sourceId: context.req.param("sourceId") ?? "",
          origin: { type: "master", kind },
        },
      });
    },
  );

  spaceRoute(
    app,
    { methods: OPTIMIZATION_METHODS, path: PRIVATE_SOURCE_ROUTE, routeClass: "private" },
    async (context, access) =>
      optimize(context, access, {
        verify: "before",
        async subject() {
          const claims = await verifySourceCapability(context.req.param("capability") ?? "", {
            spaceId: access.spaceId,
            expectedPurpose: "image_source",
            keys: access.snapshot.keysFor(access.spaceId),
            now: Math.floor(Date.now() / 1000),
            allowedSourceOrigins: access.policy.allowedSourceOrigins,
          });
          return {
            sourceId: claims.source_id,
            origin: { type: "source", locate: async () => claims.locator },
          };
        },
      }),
  );

  spaceRoute(
    app,
    { methods: OPTIMIZATION_METHODS, path: PRIVATE_MASTER_ROUTE, routeClass: "private" },
    async (context, access) =>
      optimize(context, access, {
        verify: "before",
        async subject() {
          const claims = await verifySourceCapability(context.req.param("capability") ?? "", {
            spaceId: access.spaceId,
            expectedPurpose: "master_preview",
            keys: access.snapshot.keysFor(access.spaceId),
            now: Math.floor(Date.now() / 1000),
          });
          return { sourceId: claims.source_id, origin: { type: "master", kind: claims.kind } };
        },
      }),
  );
}
