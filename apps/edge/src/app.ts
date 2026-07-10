import {
  buildCanonicalCacheUrl,
  buildR2CacheKey,
  buildSourceCacheTag,
  normalizeRenditionQuery,
  ProtocolError,
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

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error("capability key must be canonical unpadded base64url");
  }
  const padded = value
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function parseKeyRegistry(value: string): KeyRegistry {
  if (keyRegistryCache?.raw === value) return keyRegistryCache.registry;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CAPABILITY_KEYS must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CAPABILITY_KEYS must be an object keyed by Space ID");
  }

  const registry = new Map<string, ReadonlyMap<string, Uint8Array>>();
  for (const [spaceId, rawKeys] of Object.entries(parsed)) {
    if (typeof rawKeys !== "object" || rawKeys === null || Array.isArray(rawKeys)) {
      throw new Error(`CAPABILITY_KEYS.${spaceId} must be an object keyed by key ID`);
    }
    const keys = new Map<string, Uint8Array>();
    for (const [kid, rawKey] of Object.entries(rawKeys)) {
      if (typeof rawKey !== "string") {
        throw new Error(`CAPABILITY_KEYS.${spaceId}.${kid} must be a string`);
      }
      const key = decodeBase64Url(rawKey);
      if (key.byteLength !== 32) {
        throw new Error(`CAPABILITY_KEYS.${spaceId}.${kid} must decode to 32 bytes`);
      }
      keys.set(kid, key);
    }
    registry.set(spaceId, keys);
  }
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
  console.error({ error: error instanceof Error ? error.message : "unknown" }, "edge failure");
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

async function fetchOrigin(bindings: CloudflareBindings, key: string): Promise<Response> {
  const originUrl = new URL("/internal/v1/spike/rendition", bindings.ORIGIN_BASE_URL);
  originUrl.searchParams.set("key", key);
  const response = await fetch(originUrl, {
    headers: { authorization: `Bearer ${bindings.ORIGIN_AUTH_TOKEN}` },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`origin returned ${response.status}`);
  }
  return response;
}

async function populateCaches(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
  cacheTag: string,
): Promise<Response> {
  const key = await buildR2CacheKey(identity);
  const origin = await fetchOrigin(bindings, key);
  const bytes = await origin.arrayBuffer();
  const contentType = origin.headers.get("content-type") ?? "application/octet-stream";
  await bindings.RENDITION_STORE.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { cacheTag },
  });
  return new Response(bytes, { headers: { "content-type": contentType } });
}

async function privateRendition(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
): Promise<Response> {
  const canonicalUrl = await buildCanonicalCacheUrl(identity);
  const cacheKey = new Request(canonicalUrl);
  const cached = await caches.default.match(cacheKey);
  if (cached !== undefined) return privateBrowserResponse(cached, "edge-hit");

  const key = await buildR2CacheKey(identity);
  const stored = await readR2Response(bindings.RENDITION_STORE, key);
  const cacheTag = await buildSourceCacheTag(identity.spaceId, identity.sourceId);
  const response = stored ?? (await populateCaches(bindings, identity, cacheTag));
  const internalHeaders = new Headers(response.headers);
  internalHeaders.set("cache-control", `public, max-age=${PRIVATE_EDGE_TTL_SECONDS}`);
  internalHeaders.set("cache-tag", cacheTag);
  const internalResponse = new Response(await response.arrayBuffer(), { headers: internalHeaders });
  await caches.default.put(cacheKey, internalResponse.clone());
  return privateBrowserResponse(internalResponse, stored === undefined ? "origin" : "r2-hit");
}

async function publicLocatedRendition(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
  capability: string,
): Promise<Response> {
  const canonicalUrl = await buildCanonicalCacheUrl(identity);
  const cacheKey = new Request(canonicalUrl);
  const cacheTag = await buildSourceCacheTag(identity.spaceId, identity.sourceId);
  const cached = await caches.default.match(cacheKey);
  if (cached !== undefined) return publicBrowserResponse(cached, "edge-hit", cacheTag);

  const key = await buildR2CacheKey(identity);
  const stored = await readR2Response(bindings.RENDITION_STORE, key);
  if (stored !== undefined) {
    const response = publicBrowserResponse(stored, "r2-hit", cacheTag);
    await caches.default.put(cacheKey, response.clone());
    return response;
  }

  const policy = getSpacePolicy(identity.spaceId);
  if (policy === undefined || policy.routeClass !== "public") return notFound();
  const keys = parseKeyRegistry(bindings.CAPABILITY_KEYS).get(identity.spaceId) ?? new Map();
  await verifySourceCapability(capability, {
    spaceId: identity.spaceId,
    expectedPurpose: "image_source",
    expectedSourceId: identity.sourceId,
    keys,
    now: Math.floor(Date.now() / 1000),
    allowedSourceOrigins: policy.allowedSourceOrigins,
  });
  const response = publicBrowserResponse(
    await populateCaches(bindings, identity, cacheTag),
    "origin",
    cacheTag,
  );
  await caches.default.put(cacheKey, response.clone());
  return response;
}

export const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/healthz", (context) => context.json({ ok: true, service: "edge" }));

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

app.get("/v1/public/:spaceId/located/:sourceId/:capability", async (context) => {
  try {
    const spaceId = context.req.param("spaceId");
    const policy = getSpacePolicy(spaceId);
    if (policy === undefined || policy.routeClass !== "public") return notFound();
    const query = normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
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
