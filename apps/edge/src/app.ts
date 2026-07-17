import {
  buildCanonicalCacheUrl,
  buildR2CacheKey,
  buildSourceCacheTag,
  emitOperationalEvent,
  normalizeRenditionQuery,
  operationalEvent,
  ProtocolError,
  parseCapabilityKeyRegistry,
  type RenditionCacheIdentity,
  verifySourceCapability,
} from "@shutter/protocol";
import { getSpacePolicy } from "@shutter/space-config";
import { Hono } from "hono";

const PRIVATE_EDGE_TTL_SECONDS = 86_400;
const PUBLIC_BROWSER_TTL_SECONDS = 86_400;
const PUBLIC_EDGE_TTL_SECONDS = 2_592_000;

type KeyRegistry = ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;
let keyRegistryCache: { raw: string; registry: KeyRegistry } | undefined;

async function emitRenditionEvent(
  identity: RenditionCacheIdentity,
  cacheOutcome: "edge-hit" | "r2-hit" | "origin",
): Promise<void> {
  emitOperationalEvent(
    "info",
    await operationalEvent({
      event: "edge.rendition",
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

function parseKeyRegistry(value: string): KeyRegistry {
  if (keyRegistryCache?.raw === value) return keyRegistryCache.registry;
  const registry = parseCapabilityKeyRegistry(value);
  keyRegistryCache = { raw: value, registry };
  return registry;
}

function protocolFailure(error: unknown): Response {
  if (
    error instanceof ProtocolError ||
    (error instanceof Error &&
      error.name === "ProtocolError" &&
      "code" in error &&
      typeof error.code === "string")
  ) {
    const status = error.code === "query_invalid" ? 400 : 403;
    return Response.json(
      { error: { code: error.code } },
      { status, headers: { "cache-control": "private, no-store" } },
    );
  }
  emitOperationalEvent("error", {
    event: "edge.failure",
    outcome: "failed",
    failureCode: "service_unavailable",
  });
  return Response.json(
    { error: { code: "service_unavailable" } },
    { status: 503, headers: { "cache-control": "private, no-store" } },
  );
}

function notFound(): Response {
  return Response.json(
    { error: { code: "not_found" } },
    { status: 404, headers: { "cache-control": "private, no-store" } },
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

function privateBrowserResponse(response: Response, cacheStatus: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-shutter-cache", cacheStatus);
  headers.delete("cache-tag");
  return new Response(response.body, { status: response.status, headers });
}

function publicBrowserResponse(
  response: Response,
  cacheStatus: string,
  cacheTag: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "cache-control",
    `public, max-age=${PUBLIC_BROWSER_TTL_SECONDS}, s-maxage=${PUBLIC_EDGE_TTL_SECONDS}`,
  );
  headers.set("cache-tag", cacheTag);
  headers.set("x-shutter-cache", cacheStatus);
  return new Response(response.body, { status: response.status, headers });
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
  key: string,
  sourceUrl: string,
  width: number,
  quality: number,
): Promise<Response> {
  const originUrl = new URL("/internal/v1/spike/rendition", bindings.ORIGIN_BASE_URL);
  originUrl.searchParams.set("key", key);
  originUrl.searchParams.set("source", sourceUrl);
  originUrl.searchParams.set("w", String(width));
  originUrl.searchParams.set("q", String(quality));
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
  identity: RenditionCacheIdentity,
): Promise<Response> {
  if (identity.input.type !== "master") throw new Error("master input required");
  const response = await fetch(new URL("/internal/v1/master-rendition", bindings.ORIGIN_BASE_URL), {
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
  });
  if (!response.ok) throw new Error(`origin returned ${response.status}`);
  return response;
}

async function populateCaches(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
  cacheTag: string,
  sourceUrl?: string,
): Promise<Response> {
  const key = await buildR2CacheKey(identity);
  const origin =
    sourceUrl === undefined
      ? await fetchMasterOrigin(bindings, identity)
      : await fetchOrigin(bindings, key, sourceUrl, identity.width, identity.quality);
  const bytes = await origin.arrayBuffer();
  const contentType = origin.headers.get("content-type") ?? "application/octet-stream";
  await bindings.RENDITION_STORE.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { cacheTag },
  });
  return new Response(bytes, { headers: { "content-type": contentType } });
}

type OriginSource = string | (() => Promise<string>) | undefined;

async function deliverRendition(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
  originSource?: OriginSource,
): Promise<Response> {
  const canonicalUrl = await buildCanonicalCacheUrl(identity);
  const cacheKey = new Request(canonicalUrl);
  const cacheTag = await buildSourceCacheTag(identity.spaceId, identity.sourceId);
  const cached = await caches.default.match(cacheKey);
  if (cached !== undefined) {
    await emitRenditionEvent(identity, "edge-hit");
    return identity.routeClass === "private"
      ? privateBrowserResponse(cached, "edge-hit")
      : publicBrowserResponse(cached, "edge-hit", cacheTag);
  }

  const key = await buildR2CacheKey(identity);
  const stored = await readR2Response(bindings.RENDITION_STORE, key);
  let response = stored;
  if (response === undefined) {
    const sourceUrl = typeof originSource === "function" ? await originSource() : originSource;
    response = await populateCaches(bindings, identity, cacheTag, sourceUrl);
  }
  const outcome = stored === undefined ? "origin" : "r2-hit";

  if (identity.routeClass === "private") {
    const internalHeaders = new Headers(response.headers);
    internalHeaders.set("cache-control", `public, max-age=${PRIVATE_EDGE_TTL_SECONDS}`);
    internalHeaders.set("cache-tag", cacheTag);
    const internal = new Response(await response.arrayBuffer(), { headers: internalHeaders });
    await caches.default.put(cacheKey, internal.clone());
    await emitRenditionEvent(identity, outcome);
    return privateBrowserResponse(internal, outcome);
  }

  const browser = publicBrowserResponse(response, outcome, cacheTag);
  await caches.default.put(cacheKey, browser.clone());
  await emitRenditionEvent(identity, outcome);
  return browser;
}

async function privateRendition(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
  sourceUrl?: string,
): Promise<Response> {
  return deliverRendition(bindings, identity, sourceUrl);
}

async function publicLocatedRendition(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
  capability: string,
): Promise<Response> {
  return deliverRendition(bindings, identity, async () => {
    const policy = getSpacePolicy(identity.spaceId);
    if (policy === undefined || policy.routeClass !== "public")
      throw new ProtocolError("space_mismatch", "Shutter Space is not public");
    const keys = parseKeyRegistry(bindings.CAPABILITY_KEYS).get(identity.spaceId) ?? new Map();
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

function resolveUploadThingSource(
  sourceRef: string,
  allowedProjectIds: readonly string[],
): { sourceId: string; sourceUrl: string } | undefined {
  const separator = sourceRef.indexOf("/");
  if (
    separator <= 0 ||
    separator !== sourceRef.lastIndexOf("/") ||
    separator === sourceRef.length - 1
  ) {
    return undefined;
  }
  const projectId = sourceRef.slice(0, separator);
  const fileKey = sourceRef.slice(separator + 1);
  if (
    !allowedProjectIds.includes(projectId) ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(projectId) ||
    !/^[A-Za-z0-9_-]{1,512}$/u.test(fileKey)
  ) {
    return undefined;
  }
  return {
    sourceId: sourceRef,
    sourceUrl: `https://${projectId}.ufs.sh/f/${encodeURIComponent(fileKey)}`,
  };
}

async function publicResolverRendition(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
  sourceUrl: string,
): Promise<Response> {
  return deliverRendition(bindings, identity, sourceUrl);
}

async function publicMasterRendition(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
): Promise<Response> {
  return deliverRendition(bindings, identity);
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

app.get("/v1/public/:spaceId/resolver/:resolverId/*", async (context) => {
  try {
    const spaceId = context.req.param("spaceId");
    const policy = getSpacePolicy(spaceId);
    if (policy === undefined || policy.routeClass !== "public") return notFound();
    const resolverId = context.req.param("resolverId");
    const resolver = policy.resolvers.find((candidate) => candidate.id === resolverId);
    if (resolver === undefined || resolver.type !== "uploadthing") return notFound();

    const pathname = new URL(context.req.url).pathname;
    const marker = `/resolver/${encodeURIComponent(resolverId)}/`;
    const markerIndex = pathname.indexOf(marker);
    if (markerIndex < 0) return notFound();
    const sourceRef = decodeURIComponent(pathname.slice(markerIndex + marker.length));
    const source = resolveUploadThingSource(sourceRef, resolver.allowedProjectIds);
    if (source === undefined) return notFound();
    const query = normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
    if (!query.isCanonical) {
      const canonical = new URL(context.req.url);
      canonical.search = `?w=${query.width}&q=${query.quality}`;
      return new Response(null, {
        status: 308,
        headers: {
          "cache-control": "private, no-store",
          location: canonical.toString(),
        },
      });
    }

    return await publicResolverRendition(
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
  } catch (error) {
    return protocolFailure(error);
  }
});

app.get("/v1/private/:spaceId/master/:capability", async (context) => {
  try {
    const spaceId = context.req.param("spaceId");
    const policy = getSpacePolicy(spaceId);
    if (policy === undefined || policy.routeClass !== "private") return notFound();
    const query = normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
    const keys = parseKeyRegistry(context.env.CAPABILITY_KEYS).get(spaceId) ?? new Map();
    const claims = await verifySourceCapability(context.req.param("capability"), {
      spaceId,
      expectedPurpose: "master_preview",
      keys,
      now: Math.floor(Date.now() / 1000),
    });
    if (!query.isCanonical) return canonicalRedirect(context.req.url, query.width, query.quality);
    return await privateRendition(context.env, {
      routeClass: "private",
      spaceId,
      sourceId: claims.source_id,
      input: { type: "master", kind: claims.kind },
      width: query.width,
      quality: query.quality,
    });
  } catch (error) {
    return protocolFailure(error);
  }
});

app.get("/v1/public/:spaceId/master/:kind/:sourceId", async (context) => {
  try {
    const spaceId = context.req.param("spaceId");
    const policy = getSpacePolicy(spaceId);
    if (policy === undefined || policy.routeClass !== "public") return notFound();
    const kind = context.req.param("kind");
    if (kind !== "video" && kind !== "pdf") return notFound();
    const query = normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
    if (!query.isCanonical) {
      return canonicalRedirect(context.req.url, query.width, query.quality);
    }
    return await publicMasterRendition(context.env, {
      routeClass: "public",
      spaceId,
      sourceId: context.req.param("sourceId"),
      input: { type: "master", kind },
      width: query.width,
      quality: query.quality,
    });
  } catch (error) {
    return protocolFailure(error);
  }
});

app.get("/v1/private/:spaceId/source/:capability", async (context) => {
  try {
    const spaceId = context.req.param("spaceId");
    const policy = getSpacePolicy(spaceId);
    if (policy === undefined || policy.routeClass !== "private") return notFound();
    const query = normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
    const keys = parseKeyRegistry(context.env.CAPABILITY_KEYS).get(spaceId) ?? new Map();
    const claims = await verifySourceCapability(context.req.param("capability"), {
      spaceId,
      expectedPurpose: "image_source",
      keys,
      now: Math.floor(Date.now() / 1000),
      allowedSourceOrigins: policy.allowedSourceOrigins,
    });
    if (!query.isCanonical) return canonicalRedirect(context.req.url, query.width, query.quality);
    return await privateRendition(
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
  } catch (error) {
    return protocolFailure(error);
  }
});

app.get("/v1/public/:spaceId/located/:sourceId/:capability", async (context) => {
  try {
    const spaceId = context.req.param("spaceId");
    const policy = getSpacePolicy(spaceId);
    if (policy === undefined || policy.routeClass !== "public") return notFound();
    const query = normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
    if (!query.isCanonical) return canonicalRedirect(context.req.url, query.width, query.quality);
    return await publicLocatedRendition(
      context.env,
      {
        routeClass: "public",
        spaceId,
        sourceId: context.req.param("sourceId"),
        input: { type: "source" },
        width: query.width,
        quality: query.quality,
      },
      context.req.param("capability"),
    );
  } catch (error) {
    return protocolFailure(error);
  }
});
