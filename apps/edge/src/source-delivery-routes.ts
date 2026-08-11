import { ProtocolError, verifySourceCapability } from "@shutter/protocol";
import type { Hono } from "hono";
import { getEdgeConfig } from "./config-snapshot.js";
import { methodNotAllowed, notFound, protocolFailure } from "./http-responses.js";
import { deliverSource } from "./source-delivery.js";
import { resolveUploadThingSource } from "./source-resolution.js";

type EdgeApp = Hono<{ Bindings: CloudflareBindings }>;

const PUBLIC_RESOLVER_ROUTE = "/v1/public/:spaceId/delivery/resolver/:resolverId/*";
const PUBLIC_LOCATED_ROUTE = "/v1/public/:spaceId/delivery/located/:sourceId/:capability";
const PRIVATE_ROUTE = "/v1/private/:spaceId/delivery/:capability";

function rejectQuery(requestUrl: string): void {
  if (new URL(requestUrl).search !== "") {
    throw new ProtocolError("query_invalid", "Source Delivery does not accept query parameters");
  }
}

function resolverSourceRef(requestUrl: string, resolverId: string): string | undefined {
  const pathname = new URL(requestUrl).pathname;
  const marker = `/delivery/resolver/${encodeURIComponent(resolverId)}/`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const encodedSourceRef = pathname.slice(markerIndex + marker.length);
  if (encodedSourceRef.includes("/")) return undefined;
  try {
    return decodeURIComponent(encodedSourceRef);
  } catch {
    return undefined;
  }
}

export function registerSourceDeliveryRoutes(app: EdgeApp): void {
  app.on(["GET", "HEAD"], PUBLIC_RESOLVER_ROUTE, async (context) => {
    try {
      rejectQuery(context.req.url);
      const spaceId = context.req.param("spaceId");
      const snapshot = await getEdgeConfig(context.env, context.executionCtx);
      const policy = snapshot.policyFor(spaceId);
      if (policy === undefined || policy.routeClass !== "public") return notFound();
      const resolverId = context.req.param("resolverId");
      const resolver = policy.resolvers.find((candidate) => candidate.id === resolverId);
      if (resolver === undefined || resolver.type !== "uploadthing") return notFound();
      const sourceRef = resolverSourceRef(context.req.url, resolverId);
      if (sourceRef === undefined) return notFound();
      const source = resolveUploadThingSource(sourceRef, resolver.allowedProjectIds);
      if (source === undefined) return notFound();
      return await deliverSource({
        executionCtx: context.executionCtx,
        request: context.req.raw,
        identity: { routeClass: "public", spaceId, sourceId: source.sourceId },
        locator: source.sourceUrl,
      });
    } catch (error) {
      return protocolFailure(error);
    }
  });

  app.on(["GET", "HEAD"], PUBLIC_LOCATED_ROUTE, async (context) => {
    try {
      rejectQuery(context.req.url);
      const spaceId = context.req.param("spaceId");
      const sourceId = context.req.param("sourceId");
      const snapshot = await getEdgeConfig(context.env, context.executionCtx);
      const policy = snapshot.policyFor(spaceId);
      if (policy === undefined || policy.routeClass !== "public") return notFound();
      const claims = await verifySourceCapability(context.req.param("capability"), {
        spaceId,
        expectedPurpose: "source_delivery",
        expectedSourceId: sourceId,
        keys: snapshot.keysFor(spaceId),
        now: Math.floor(Date.now() / 1000),
        allowedSourceOrigins: policy.allowedSourceOrigins,
      });
      return await deliverSource({
        executionCtx: context.executionCtx,
        request: context.req.raw,
        identity: { routeClass: "public", spaceId, sourceId },
        locator: claims.locator,
      });
    } catch (error) {
      return protocolFailure(error);
    }
  });

  app.on(["GET", "HEAD"], PRIVATE_ROUTE, async (context) => {
    try {
      rejectQuery(context.req.url);
      const spaceId = context.req.param("spaceId");
      const snapshot = await getEdgeConfig(context.env, context.executionCtx);
      const policy = snapshot.policyFor(spaceId);
      if (policy === undefined || policy.routeClass !== "private") return notFound();
      const claims = await verifySourceCapability(context.req.param("capability"), {
        spaceId,
        expectedPurpose: "source_delivery",
        keys: snapshot.keysFor(spaceId),
        now: Math.floor(Date.now() / 1000),
        allowedSourceOrigins: policy.allowedSourceOrigins,
      });
      return await deliverSource({
        executionCtx: context.executionCtx,
        request: context.req.raw,
        identity: { routeClass: "private", spaceId, sourceId: claims.source_id },
        locator: claims.locator,
      });
    } catch (error) {
      return protocolFailure(error);
    }
  });

  for (const route of [PUBLIC_RESOLVER_ROUTE, PUBLIC_LOCATED_ROUTE, PRIVATE_ROUTE]) {
    app.all(route, () => methodNotAllowed());
  }
}
