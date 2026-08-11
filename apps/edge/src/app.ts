import {
  buildCanonicalCacheUrl,
  buildR2CacheKey,
  buildSourceCacheTag,
  CapabilityError,
  emitOperationalEvent,
  isProtocolError,
  normalizeRenditionQuery,
  operationalEvent,
  type ProtocolError,
  parseCapabilityKeyRegistry,
  type RenditionCacheIdentity,
  verifySourceCapability,
} from "@shutter/protocol";
import { getSpacePolicy } from "@shutter/space-config";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Hono } from "hono";

declare module "hono" {
  interface ExecutionContext {
    cache?: CacheContext;
  }
}

const PRIVATE_EDGE_TTL_SECONDS = 86_400;
const PUBLIC_BROWSER_TTL_SECONDS = 86_400;
const PUBLIC_EDGE_TTL_SECONDS = 2_592_000;

type KeyRegistry = ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;
let keyRegistryCache: { raw: string; registry: KeyRegistry } | undefined;

// The Edge graph has no Node services. One module-scope runtime built from this
// Worker-safe layer owns every Effect started by a Hono handler.
const workerRuntime = ManagedRuntime.make(Layer.empty);

function emitRenditionEvent(
  identity: RenditionCacheIdentity,
  cacheOutcome: "edge-hit" | "r2-hit" | "origin",
): Effect.Effect<void> {
  return operationalEvent({
    event: "edge.rendition",
    spaceId: identity.spaceId,
    sourceId: identity.sourceId,
    fields: {
      routeClass: identity.routeClass,
      cacheOutcome,
      ...(identity.input.type === "master" ? { kind: identity.input.kind } : {}),
    },
  }).pipe(
    Effect.tap((event) => Effect.sync(() => emitOperationalEvent("info", event))),
    Effect.asVoid,
  );
}

function parseKeyRegistry(value: string): KeyRegistry {
  if (keyRegistryCache?.raw === value) return keyRegistryCache.registry;
  const registry = parseCapabilityKeyRegistry(value);
  keyRegistryCache = { raw: value, registry };
  return registry;
}

function protocolFailure(error: unknown): Response {
  if (isProtocolError(error)) {
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

function runWorkerEffect<E>(effect: Effect.Effect<Response, E>): Promise<Response> {
  return workerRuntime.runPromise(
    effect.pipe(
      Effect.catch((error) => Effect.sync(() => protocolFailure(error))),
      Effect.catchCause(() => Effect.sync(() => protocolFailure(undefined))),
    ),
  );
}

function notFound(): Response {
  return Response.json(
    { error: { code: "not_found" } },
    { status: 404, headers: { "cache-control": "private, no-store" } },
  );
}

function requestFailure(status: number, code: string, authenticate = false): Response {
  return Response.json(
    { error: { code } },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
        ...(authenticate ? { "www-authenticate": "Bearer" } : {}),
      },
    },
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

function readR2Response(bucket: R2Bucket, key: string): Effect.Effect<Response | undefined> {
  return Effect.gen(function* () {
    const object = yield* Effect.promise(() => bucket.get(key));
    if (object === null) return undefined;
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (object.httpEtag !== undefined) headers.set("etag", object.httpEtag);
    return new Response(object.body, { headers });
  });
}

function fetchOrigin(
  bindings: CloudflareBindings,
  key: string,
  sourceUrl: string,
  width: number,
  quality: number,
): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const originUrl = new URL("/internal/v1/spike/rendition", bindings.ORIGIN_BASE_URL);
    originUrl.searchParams.set("key", key);
    originUrl.searchParams.set("source", sourceUrl);
    originUrl.searchParams.set("w", String(width));
    originUrl.searchParams.set("q", String(quality));
    const response = yield* Effect.promise((signal) =>
      fetch(originUrl, {
        headers: { authorization: `Bearer ${bindings.ORIGIN_AUTH_TOKEN}` },
        redirect: "manual",
        signal,
      }),
    );
    if (!response.ok) return yield* Effect.die(new Error(`origin returned ${response.status}`));
    return response;
  });
}

function fetchMasterOrigin(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
): Effect.Effect<Response> {
  return Effect.gen(function* () {
    if (identity.input.type !== "master") {
      return yield* Effect.die(new Error("master input required"));
    }
    const kind = identity.input.kind;
    const response = yield* Effect.promise((signal) =>
      fetch(new URL("/internal/v1/master-rendition", bindings.ORIGIN_BASE_URL), {
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
        signal,
      }),
    );
    if (!response.ok) return yield* Effect.die(new Error(`origin returned ${response.status}`));
    return response;
  });
}

function populateCaches(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
  cacheTag: string,
  sourceUrl?: string,
): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const key = yield* Effect.promise(() => buildR2CacheKey(identity));
    const origin = yield* sourceUrl === undefined
      ? fetchMasterOrigin(bindings, identity)
      : fetchOrigin(bindings, key, sourceUrl, identity.width, identity.quality);
    const bytes = yield* Effect.promise(() => origin.arrayBuffer());
    const contentType = origin.headers.get("content-type") ?? "application/octet-stream";
    yield* Effect.promise(() =>
      bindings.RENDITION_STORE.put(key, bytes, {
        httpMetadata: { contentType },
        customMetadata: { cacheTag },
      }),
    );
    return new Response(bytes, { headers: { "content-type": contentType } });
  });
}

type OriginSource = string | Effect.Effect<string, ProtocolError> | undefined;

function deliverRendition(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
  originSource?: OriginSource,
): Effect.Effect<Response, ProtocolError> {
  return Effect.gen(function* () {
    const canonicalUrl = yield* Effect.promise(() => buildCanonicalCacheUrl(identity));
    const cacheKey = new Request(canonicalUrl);
    const cacheTag = yield* Effect.promise(() =>
      buildSourceCacheTag(identity.spaceId, identity.sourceId),
    );
    const cached = yield* Effect.promise(() => caches.default.match(cacheKey));
    if (cached !== undefined) {
      yield* emitRenditionEvent(identity, "edge-hit");
      return identity.routeClass === "private"
        ? privateBrowserResponse(cached, "edge-hit")
        : publicBrowserResponse(cached, "edge-hit", cacheTag);
    }

    const key = yield* Effect.promise(() => buildR2CacheKey(identity));
    const stored = yield* readR2Response(bindings.RENDITION_STORE, key);
    let response = stored;
    if (response === undefined) {
      const sourceUrl =
        typeof originSource === "string"
          ? originSource
          : originSource === undefined
            ? undefined
            : yield* originSource;
      response = yield* populateCaches(bindings, identity, cacheTag, sourceUrl);
    }
    const outcome = stored === undefined ? "origin" : "r2-hit";

    if (identity.routeClass === "private") {
      const internalHeaders = new Headers(response.headers);
      internalHeaders.set("cache-control", `public, max-age=${PRIVATE_EDGE_TTL_SECONDS}`);
      internalHeaders.set("cache-tag", cacheTag);
      const bytes = yield* Effect.promise(() => response.arrayBuffer());
      const internal = new Response(bytes, { headers: internalHeaders });
      yield* Effect.promise(() => caches.default.put(cacheKey, internal.clone()));
      yield* emitRenditionEvent(identity, outcome);
      return privateBrowserResponse(internal, outcome);
    }

    const browser = publicBrowserResponse(response, outcome, cacheTag);
    yield* Effect.promise(() => caches.default.put(cacheKey, browser.clone()));
    yield* emitRenditionEvent(identity, outcome);
    return browser;
  });
}

function publicLocatedRendition(
  bindings: CloudflareBindings,
  identity: RenditionCacheIdentity,
  capability: string,
): Effect.Effect<Response, ProtocolError> {
  const sourceUrl = Effect.gen(function* () {
    const policy = getSpacePolicy(identity.spaceId);
    if (policy === undefined || policy.routeClass !== "public") {
      return yield* Effect.fail(
        new CapabilityError({
          code: "space_mismatch",
          message: "Shutter Space is not public",
        }),
      );
    }
    const keys = parseKeyRegistry(bindings.CAPABILITY_KEYS).get(identity.spaceId) ?? new Map();
    const claims = yield* verifySourceCapability(capability, {
      spaceId: identity.spaceId,
      expectedPurpose: "image_source",
      expectedSourceId: identity.sourceId,
      keys,
      now: Math.floor(Date.now() / 1000),
      allowedSourceOrigins: policy.allowedSourceOrigins,
    });
    return claims.locator;
  });
  return deliverRendition(bindings, identity, sourceUrl);
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

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= (left.at(index) ?? 0) ^ (right.at(index) ?? 0);
  }
  return diff === 0;
}

function authorizedOrigin(
  header: string | undefined,
  expectedToken: string,
): Effect.Effect<boolean> {
  if (expectedToken.length < 32 || header === undefined || !header.startsWith("Bearer ")) {
    return Effect.succeed(false);
  }
  const encoder = new TextEncoder();
  return Effect.gen(function* () {
    const [actual, expected] = yield* Effect.all([
      Effect.promise(() =>
        crypto.subtle.digest("SHA-256", encoder.encode(header.slice("Bearer ".length))),
      ),
      Effect.promise(() => crypto.subtle.digest("SHA-256", encoder.encode(expectedToken))),
    ]);
    return timingSafeEqualBytes(new Uint8Array(actual), new Uint8Array(expected));
  });
}

function validPurgeBody(body: unknown): body is { tags: string[] } {
  return (
    typeof body === "object" &&
    body !== null &&
    "tags" in body &&
    Array.isArray(body.tags) &&
    body.tags.length > 0 &&
    !body.tags.some((tag) => typeof tag !== "string" || tag.length === 0) &&
    Object.keys(body).sort().join(",") === "tags"
  );
}

export const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/healthz", () =>
  runWorkerEffect(Effect.succeed(Response.json({ ok: true, service: "edge" }))),
);

app.post("/internal/v1/cache/purge", (context) =>
  runWorkerEffect(
    Effect.gen(function* () {
      const authorized = yield* authorizedOrigin(
        context.req.header("authorization"),
        context.env.ORIGIN_AUTH_TOKEN,
      );
      if (!authorized) return requestFailure(401, "unauthorized", true);

      const parsedBody = yield* Effect.tryPromise({
        try: () => context.req.json(),
        catch: () => undefined,
      }).pipe(
        Effect.match({
          onFailure: () => ({ _tag: "Invalid" as const }),
          onSuccess: (body) => ({ _tag: "Parsed" as const, body }),
        }),
      );
      if (parsedBody._tag === "Invalid" || !validPurgeBody(parsedBody.body)) {
        return requestFailure(400, "request_invalid");
      }

      const cache = context.executionCtx.cache;
      if (cache === undefined) return requestFailure(503, "service_unavailable");
      const result = yield* Effect.promise(() => cache.purge({ tags: parsedBody.body.tags }));
      if (!result.success) return requestFailure(503, "service_unavailable");
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "private, no-store" },
      });
    }),
  ),
);

app.get("/v1/public/:spaceId/resolver/:resolverId/*", (context) =>
  runWorkerEffect(
    Effect.gen(function* () {
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
      const query = yield* normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
      if (!query.isCanonical) {
        return canonicalRedirect(context.req.url, query.width, query.quality);
      }

      return yield* deliverRendition(
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
    }),
  ),
);

app.get("/v1/private/:spaceId/master/:capability", (context) =>
  runWorkerEffect(
    Effect.gen(function* () {
      const spaceId = context.req.param("spaceId");
      const policy = getSpacePolicy(spaceId);
      if (policy === undefined || policy.routeClass !== "private") return notFound();
      const query = yield* normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
      const keys = parseKeyRegistry(context.env.CAPABILITY_KEYS).get(spaceId) ?? new Map();
      const claims = yield* verifySourceCapability(context.req.param("capability"), {
        spaceId,
        expectedPurpose: "master_preview",
        keys,
        now: Math.floor(Date.now() / 1000),
      });
      if (!query.isCanonical) {
        return canonicalRedirect(context.req.url, query.width, query.quality);
      }
      return yield* deliverRendition(context.env, {
        routeClass: "private",
        spaceId,
        sourceId: claims.source_id,
        input: { type: "master", kind: claims.kind },
        width: query.width,
        quality: query.quality,
      });
    }),
  ),
);

app.get("/v1/public/:spaceId/master/:kind/:sourceId", (context) =>
  runWorkerEffect(
    Effect.gen(function* () {
      const spaceId = context.req.param("spaceId");
      const policy = getSpacePolicy(spaceId);
      if (policy === undefined || policy.routeClass !== "public") return notFound();
      const kind = context.req.param("kind");
      if (kind !== "video" && kind !== "pdf") return notFound();
      const query = yield* normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
      if (!query.isCanonical) {
        return canonicalRedirect(context.req.url, query.width, query.quality);
      }
      return yield* deliverRendition(context.env, {
        routeClass: "public",
        spaceId,
        sourceId: context.req.param("sourceId"),
        input: { type: "master", kind },
        width: query.width,
        quality: query.quality,
      });
    }),
  ),
);

app.get("/v1/private/:spaceId/source/:capability", (context) =>
  runWorkerEffect(
    Effect.gen(function* () {
      const spaceId = context.req.param("spaceId");
      const policy = getSpacePolicy(spaceId);
      if (policy === undefined || policy.routeClass !== "private") return notFound();
      const query = yield* normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
      const keys = parseKeyRegistry(context.env.CAPABILITY_KEYS).get(spaceId) ?? new Map();
      const claims = yield* verifySourceCapability(context.req.param("capability"), {
        spaceId,
        expectedPurpose: "image_source",
        keys,
        now: Math.floor(Date.now() / 1000),
        allowedSourceOrigins: policy.allowedSourceOrigins,
      });
      if (!query.isCanonical) {
        return canonicalRedirect(context.req.url, query.width, query.quality);
      }
      return yield* deliverRendition(
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
    }),
  ),
);

app.get("/v1/public/:spaceId/located/:sourceId/:capability", (context) =>
  runWorkerEffect(
    Effect.gen(function* () {
      const spaceId = context.req.param("spaceId");
      const policy = getSpacePolicy(spaceId);
      if (policy === undefined || policy.routeClass !== "public") return notFound();
      const query = yield* normalizeRenditionQuery(new URL(context.req.url).searchParams, policy);
      if (!query.isCanonical) {
        return canonicalRedirect(context.req.url, query.width, query.quality);
      }
      return yield* publicLocatedRendition(
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
    }),
  ),
);
