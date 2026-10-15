import {
  CONTROL_HTTP_ROUTES,
  emitOperationalEvent,
  masterPreviewKeyFor,
  normalizeOptimizationQuery,
  type OperationalEvent,
  type OptimizationCacheIdentity,
  type OptimizationCacheNames,
  type OptimizationInput,
  type OptimizeInput,
  operationalErrorType,
  optimizationCacheNames,
  type PreviewKind,
  verifySourceCapability,
} from "@shutter/protocol";
import type { Context, Hono } from "hono";
import type { WaitUntilContext } from "./config-snapshot.js";
import { edgeBrowserResponse, internalEdgeCacheResponse } from "./edge-cache-policy.js";
import { notFound } from "./http-responses.js";
import { type SpaceRouteAccess, spaceRoute } from "./space-route.js";

type EdgeEnv = { Bindings: CloudflareBindings };
type EdgeApp = Hono<EdgeEnv>;

/**
 * What one delivery needs from its request: the bindings, and somewhere to
 * finish cache writes after the response has gone. A Hono context is one.
 */
export interface DeliveryContext {
  env: CloudflareBindings;
  executionCtx: WaitUntilContext;
}

const PUBLIC_LOCATED_ROUTE = "/v1/public/:spaceId/located/:sourceId/:capability";
const PUBLIC_MASTER_ROUTE = "/v1/public/:spaceId/master/:kind/:sourceId";
const PRIVATE_SOURCE_ROUTE = "/v1/private/:spaceId/source/:capability";
const PRIVATE_MASTER_ROUTE = "/v1/private/:spaceId/master/:capability";
const OPTIMIZATION_METHODS = ["GET"] as const;
const CONTENT_LENGTH = /^\d{1,16}$/u;

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

/**
 * One `edge.delivery` event per response. The source hash is the fingerprint
 * the cache names already hold, so emitting is synchronous and adds no digest
 * and no await to the response path.
 */
function emitDeliveryEvent(
  identity: OptimizationCacheIdentity,
  sourceHash: string,
  cacheOutcome: "edge-hit" | "r2-hit" | "origin",
  apiVersion: ApiVersion,
): void {
  const event: OperationalEvent = {
    event: "edge.delivery",
    sourceHash,
    routeClass: identity.routeClass,
    apiVersion,
    cacheOutcome,
  };
  if (identity.input.type === "master") event.kind = identity.input.kind;
  emitOperationalEvent("info", event);
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

/**
 * The one Edge-to-Control optimize call. Every input, a located source from
 * a v1 capability, a resolver reference, or a stored master, travels as a
 * tagged body; no locator ever sits in a query string.
 */
async function fetchOptimize(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  input: OptimizeInput,
): Promise<Response> {
  const response = await fetch(new URL(CONTROL_HTTP_ROUTES.optimize, bindings.ORIGIN_BASE_URL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${bindings.ORIGIN_AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: identity.spaceId,
      input,
      width: identity.width,
      quality: identity.quality,
    }),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`origin returned ${response.status}`);

  return response;
}

/** Renders at the origin; `undefined` means the Master Preview the request named does not exist. */
async function renderAtOrigin(
  bindings: CloudflareBindings,
  identity: OptimizationCacheIdentity,
  names: OptimizationCacheNames,
  origin: OptimizationOrigin,
): Promise<Response | undefined> {
  switch (origin.type) {
    case "master": {
      if (origin.requireStored === true) {
        const masterKey = masterPreviewKeyFor(
          { spaceId: identity.spaceId, sourceHash: names.sourceHash },
          origin.kind,
        );
        if ((await bindings.MEDIA_STORE.head(masterKey)) === null) return undefined;
      }

      return fetchOptimize(bindings, identity, {
        type: "master",
        sourceId: identity.sourceId,
        kind: origin.kind,
      });
    }
    case "resolved":
      return fetchOptimize(bindings, identity, {
        type: "resolved",
        resolverId: origin.resolverId,
        reference: origin.reference,
      });
    case "source":
      return fetchOptimize(bindings, identity, {
        type: "located",
        sourceUrl: await origin.locate(),
      });
  }
}

/** A length the Edge can stream a render with: present, well formed, and not content-encoded. */
function streamableLength(rendered: Response): number | undefined {
  const encoding = rendered.headers.get("content-encoding");
  if (encoding !== null && encoding !== "identity") return undefined;
  const value = rendered.headers.get("content-length");
  if (value === null || !CONTENT_LENGTH.test(value)) return undefined;
  const length = Number(value);

  return Number.isSafeInteger(length) ? length : undefined;
}

/** The three readers of one fresh render: the browser, R2, and the Edge cache. */
interface RenderedBodies {
  client: ReadableStream | ArrayBuffer;
  r2: ReadableStream | ArrayBuffer;
  cache: ReadableStream | ArrayBuffer;
}

/**
 * Splits a fresh render three ways. With a trustworthy length the body
 * streams: it runs through one FixedLengthStream before the tee, and the tee
 * branches keep that length, which gives the browser a Content-Length and R2
 * the known length a streamed put needs. A render that ends short errors every
 * branch, so it is never stored. Without a length, the body is read once.
 * (workerd cannot pipe a tee branch into a FixedLengthStream, so the order of
 * the two steps matters.)
 */
async function renderedBodies(rendered: Response): Promise<RenderedBodies> {
  const length = streamableLength(rendered);
  if (length === undefined || rendered.body === null) {
    const bytes = await rendered.arrayBuffer();

    return { client: bytes, r2: bytes, cache: bytes };
  }
  const [client, stores] = rendered.body.pipeThrough(new FixedLengthStream(length)).tee();
  const [r2, cache] = stores.tee();

  return { client, r2, cache };
}

/**
 * Writes a fresh render to R2. A failure only costs a later re-render, but it
 * is logged: unlike an Edge cache miss, it would repeat for every request.
 */
async function storeRender(
  bucket: R2Bucket,
  names: OptimizationCacheNames,
  body: ReadableStream | ArrayBuffer,
  contentType: string,
): Promise<void> {
  try {
    await bucket.put(names.r2Key, body, {
      httpMetadata: { contentType },
      customMetadata: { cacheTag: names.cacheTag },
    });
  } catch (error) {
    emitOperationalEvent("error", {
      event: "edge.failure",
      outcome: "failed",
      errorType: operationalErrorType(error),
    });
  }
}

/**
 * Hands a fresh render to the browser and writes it to R2 and the Edge cache
 * after the response, so neither write delays it.
 */
async function deliverRendered(
  context: DeliveryContext,
  identity: OptimizationCacheIdentity,
  names: OptimizationCacheNames,
  rendered: Response,
): Promise<Response> {
  const contentType = rendered.headers.get("content-type") ?? "application/octet-stream";
  const bodies = await renderedBodies(rendered);
  context.executionCtx.waitUntil(
    storeRender(context.env.MEDIA_STORE, names, bodies.r2, contentType),
  );
  const headers = { "content-type": contentType };
  const stored = internalEdgeCacheResponse(
    new Response(bodies.cache, { headers }),
    identity.routeClass,
    names.cacheTag,
  );
  context.executionCtx.waitUntil(
    caches.default.put(new Request(names.canonicalUrl), stored).catch(() => undefined),
  );

  return internalEdgeCacheResponse(
    new Response(bodies.client, { headers }),
    identity.routeClass,
    names.cacheTag,
  );
}

/**
 * Delivers one Image Optimization under one cache identity: the Edge cache,
 * then R2, then the origin. Every optimization route, v1 or v2, ends here
 * after it has settled its subject and canonical parameters. Only reads sit
 * on the response path; the Edge cache and R2 writes finish in `waitUntil`.
 */
export async function deliverOptimization(
  context: DeliveryContext,
  identity: OptimizationCacheIdentity,
  origin: OptimizationOrigin,
  apiVersion: ApiVersion,
): Promise<Response> {
  const names = await optimizationCacheNames(identity);
  const cacheKey = new Request(names.canonicalUrl);
  const cached = await caches.default.match(cacheKey);
  if (cached !== undefined) {
    emitDeliveryEvent(identity, names.sourceHash, "edge-hit", apiVersion);

    return edgeBrowserResponse(cached, {
      routeClass: identity.routeClass,
      cacheStatus: "edge-hit",
      cacheTag: names.cacheTag,
    });
  }

  const stored = await readR2Response(context.env.MEDIA_STORE, names.r2Key);
  if (stored !== undefined) {
    const internal = internalEdgeCacheResponse(stored, identity.routeClass, names.cacheTag);
    context.executionCtx.waitUntil(
      caches.default.put(cacheKey, internal.clone()).catch(() => undefined),
    );
    emitDeliveryEvent(identity, names.sourceHash, "r2-hit", apiVersion);

    return edgeBrowserResponse(internal, {
      routeClass: identity.routeClass,
      cacheStatus: "r2-hit",
      cacheTag: names.cacheTag,
    });
  }

  const rendered = await renderAtOrigin(context.env, identity, names, origin);
  if (rendered === undefined) return notFound();
  const response = await deliverRendered(context, identity, names, rendered);
  emitDeliveryEvent(identity, names.sourceHash, "origin", apiVersion);

  return edgeBrowserResponse(response, {
    routeClass: identity.routeClass,
    cacheStatus: "origin",
    cacheTag: names.cacheTag,
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

  return deliverOptimization(context, identity, subject.origin, "v1");
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
            keys: await access.snapshot.verificationKeysFor(access.spaceId),
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
            keys: await access.snapshot.verificationKeysFor(access.spaceId),
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
            keys: await access.snapshot.verificationKeysFor(access.spaceId),
            now: Math.floor(Date.now() / 1000),
          });

          return { sourceId: claims.source_id, origin: { type: "master", kind: claims.kind } };
        },
      }),
  );
}
