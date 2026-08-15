import {
  buildCanonicalCacheUrl,
  buildOptimizeSourceQuery,
  buildR2CacheKey,
  buildSourceCacheTag,
  CONTROL_HTTP_ROUTES,
  emitOperationalEvent,
  normalizeOptimizationQuery,
  type OptimizationCacheIdentity,
  operationalEvent,
  type SpacePolicy,
  verifySourceCapability,
} from "@shutter/protocol";
import { Hono } from "hono";
import { edgeBrowserResponse, internalEdgeCacheResponse } from "./edge-cache-policy.js";
import { notFound } from "./http-responses.js";
import { registerSourceDeliveryRoutes } from "./source-delivery-routes.js";
import { resolverSourceRef, resolveUploadThingSource } from "./source-resolution.js";
import { spaceRoute } from "./space-route.js";

declare module "hono" {
  interface ExecutionContext {
    cache?: CacheContext;
  }
}

async function emitDeliveryEvent(
  identity: OptimizationCacheIdentity,
  cacheOutcome: "edge-hit" | "r2-hit" | "origin",
): Promise<void> {
  emitOperationalEvent(
    "info",
    await operationalEvent({
      event: "edge.delivery",
      spaceId: identity.spaceId,
      sourceId: identity.sourceId,
      fields: {
        routeClass: identity.routeClass,
        cacheOutcome,
        ...(identity.input.type === "master" ? { kind: identity.input.kind } : {}),
      },
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

async function fetchMasterOrigin(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
): Promise<Response> {
  if (identity.input.type !== "master") throw new Error("master input required");
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
        kind: identity.input.kind,
        w: identity.width,
        q: identity.quality,
      }),
      redirect: "manual",
    },
  );
  if (!response.ok) throw new Error(`origin returned ${response.status}`);
  return response;
}

async function populateCaches(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  cacheTag: string,
  sourceUrl?: string,
): Promise<Response> {
  const key = await buildR2CacheKey(identity);
  const origin =
    sourceUrl === undefined
      ? await fetchMasterOrigin(bindings, identity)
      : await fetchOrigin(bindings, identity, sourceUrl);
  const bytes = await origin.arrayBuffer();
  const contentType = origin.headers.get("content-type") ?? "application/octet-stream";
  await bindings.MEDIA_STORE.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { cacheTag },
  });
  return new Response(bytes, { headers: { "content-type": contentType } });
}

type OriginSource = string | (() => Promise<string>) | undefined;

async function deliverOptimizedImage(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  originSource?: OriginSource,
): Promise<Response> {
  const canonicalUrl = await buildCanonicalCacheUrl(identity);
  const cacheKey = new Request(canonicalUrl);
  const cacheTag = await buildSourceCacheTag(identity.spaceId, identity.sourceId);
  const cached = await caches.default.match(cacheKey);
  if (cached !== undefined) {
    await emitDeliveryEvent(identity, "edge-hit");
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
    const sourceUrl = typeof originSource === "function" ? await originSource() : originSource;
    response = await populateCaches(bindings, identity, cacheTag, sourceUrl);
  }
  const outcome = stored === undefined ? "origin" : "r2-hit";

  const internal = internalEdgeCacheResponse(response, identity.routeClass, cacheTag);
  await caches.default.put(cacheKey, internal.clone());
  await emitDeliveryEvent(identity, outcome);
  return edgeBrowserResponse(internal, {
    routeClass: identity.routeClass,
    cacheStatus: outcome,
    cacheTag,
  });
}

async function privateDelivery(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  sourceUrl?: string,
): Promise<Response> {
  return deliverOptimizedImage(bindings, identity, sourceUrl);
}

async function publicLocatedDelivery(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  capability: string,
  policy: SpacePolicy,
  keys: ReadonlyMap<string, Uint8Array>,
): Promise<Response> {
  return deliverOptimizedImage(bindings, identity, async () => {
    const claims = await verifySourceCapability(capability, {
      spaceId: identity.spaceId,
      expectedPurpose: "image_source",
      expectedSourceId: identity.sourceId,
      keys,
      now: Math.floor(Date.now() / 1000),
      allowedSourceOrigins: policy.allowedSourceOrigins,
    });
    return claims.locator;
  });
}

async function publicResolverDelivery(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  sourceUrl: string,
): Promise<Response> {
  return deliverOptimizedImage(bindings, identity, sourceUrl);
}

async function publicMasterDelivery(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
): Promise<Response> {
  return deliverOptimizedImage(bindings, identity);
}

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= (left.at(index) ?? 0) ^ (right.at(index) ?? 0);
  }
  return diff === 0;
}

async function authorizedOrigin(
  header: string | undefined,
  expectedToken: string,
): Promise<boolean> {
  if (expectedToken.length < 32 || header === undefined || !header.startsWith("Bearer "))
    return false;
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header.slice("Bearer ".length))),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
  ]);
  return timingSafeEqualBytes(new Uint8Array(actual), new Uint8Array(expected));
}

export const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/healthz", (context) => context.json({ ok: true, service: "edge" }));

registerSourceDeliveryRoutes(app);

app.post("/internal/v1/cache/purge", async (context) => {
  if (
    !(await authorizedOrigin(context.req.header("authorization"), context.env.ORIGIN_AUTH_TOKEN))
  ) {
    return context.json({ error: { code: "unauthorized" } }, 401, {
      "cache-control": "private, no-store",
      "www-authenticate": "Bearer",
    });
  }

  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: { code: "request_invalid" } }, 400, {
      "cache-control": "private, no-store",
    });
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("tags" in body) ||
    !Array.isArray(body.tags) ||
    body.tags.length === 0 ||
    body.tags.some((tag) => typeof tag !== "string" || tag.length === 0) ||
    Object.keys(body).sort().join(",") !== "tags"
  ) {
    return context.json({ error: { code: "request_invalid" } }, 400, {
      "cache-control": "private, no-store",
    });
  }

  const cache = context.executionCtx.cache;
  if (cache === undefined) {
    return context.json({ error: { code: "service_unavailable" } }, 503, {
      "cache-control": "private, no-store",
    });
  }
  const result = await cache.purge({ tags: body.tags as string[] });
  if (!result.success) {
    return context.json({ error: { code: "service_unavailable" } }, 503, {
      "cache-control": "private, no-store",
    });
  }
  return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
});

spaceRoute(
  app,
  { methods: ["GET"], path: "/v1/public/:spaceId/resolver/:resolverId/*", routeClass: "public" },
  async (context, { spaceId, policy }) => {
    const resolverId = context.req.param("resolverId") ?? "";
    const resolver = policy.resolvers.find((candidate) => candidate.id === resolverId);
    if (resolver === undefined || resolver.type !== "uploadthing") return notFound();
    const sourceRef = resolverSourceRef(context.req.url, resolverId);
    if (sourceRef === undefined) return notFound();
    const source = resolveUploadThingSource(sourceRef, resolver.allowedProjectIds);
    if (source === undefined) return notFound();
    const query = normalizeOptimizationQuery(new URL(context.req.url).searchParams, policy);
    if (!query.isCanonical) {
      return canonicalRedirect(context.req.url, query.width, query.quality);
    }
    return publicResolverDelivery(
      context.env,
      {
        routeClass: "public",
        spaceId,
        sourceId: source.sourceId,
        input: { type: "source" },
        width: query.width,
        quality: query.quality,
      },
      source.sourceUrl,
    );
  },
);

spaceRoute(
  app,
  { methods: ["GET"], path: "/v1/private/:spaceId/master/:capability", routeClass: "private" },
  async (context, { spaceId, policy, snapshot }) => {
    const query = normalizeOptimizationQuery(new URL(context.req.url).searchParams, policy);
    const claims = await verifySourceCapability(context.req.param("capability") ?? "", {
      spaceId,
      expectedPurpose: "master_preview",
      keys: snapshot.keysFor(spaceId),
      now: Math.floor(Date.now() / 1000),
    });
    if (!query.isCanonical) return canonicalRedirect(context.req.url, query.width, query.quality);
    return privateDelivery(context.env, {
      routeClass: "private",
      spaceId,
      sourceId: claims.source_id,
      input: { type: "master", kind: claims.kind },
      width: query.width,
      quality: query.quality,
    });
  },
);

spaceRoute(
  app,
  { methods: ["GET"], path: "/v1/public/:spaceId/master/:kind/:sourceId", routeClass: "public" },
  async (context, { spaceId, policy }) => {
    const kind = context.req.param("kind") ?? "";
    if (kind !== "video" && kind !== "pdf") return notFound();
    const query = normalizeOptimizationQuery(new URL(context.req.url).searchParams, policy);
    if (!query.isCanonical) {
      return canonicalRedirect(context.req.url, query.width, query.quality);
    }
    return publicMasterDelivery(context.env, {
      routeClass: "public",
      spaceId,
      sourceId: context.req.param("sourceId") ?? "",
      input: { type: "master", kind },
      width: query.width,
      quality: query.quality,
    });
  },
);

spaceRoute(
  app,
  { methods: ["GET"], path: "/v1/private/:spaceId/source/:capability", routeClass: "private" },
  async (context, { spaceId, policy, snapshot }) => {
    const query = normalizeOptimizationQuery(new URL(context.req.url).searchParams, policy);
    const claims = await verifySourceCapability(context.req.param("capability") ?? "", {
      spaceId,
      expectedPurpose: "image_source",
      keys: snapshot.keysFor(spaceId),
      now: Math.floor(Date.now() / 1000),
      allowedSourceOrigins: policy.allowedSourceOrigins,
    });
    if (!query.isCanonical) return canonicalRedirect(context.req.url, query.width, query.quality);
    return privateDelivery(
      context.env,
      {
        routeClass: "private",
        spaceId,
        sourceId: claims.source_id,
        input: { type: "source" },
        width: query.width,
        quality: query.quality,
      },
      claims.locator,
    );
  },
);

spaceRoute(
  app,
  {
    methods: ["GET"],
    path: "/v1/public/:spaceId/located/:sourceId/:capability",
    routeClass: "public",
  },
  async (context, { spaceId, policy, snapshot }) => {
    const query = normalizeOptimizationQuery(new URL(context.req.url).searchParams, policy);
    if (!query.isCanonical) return canonicalRedirect(context.req.url, query.width, query.quality);
    return publicLocatedDelivery(
      context.env,
      {
        routeClass: "public",
        spaceId,
        sourceId: context.req.param("sourceId") ?? "",
        input: { type: "source" },
        width: query.width,
        quality: query.quality,
      },
      context.req.param("capability") ?? "",
      policy,
      snapshot.keysFor(spaceId),
    );
  },
);
