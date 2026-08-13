import { ProtocolError, verifySourceCapability } from "@shutter/protocol";
import type { Hono } from "hono";
import { methodNotAllowed, notFound } from "./http-responses.js";
import { deliverSource } from "./source-delivery.js";
import { resolverSourceRef, resolveUploadThingSource } from "./source-resolution.js";
import { spaceRoute } from "./space-route.js";

type EdgeApp = Hono<{ Bindings: CloudflareBindings }>;

const PUBLIC_RESOLVER_ROUTE = "/v1/public/:spaceId/delivery/resolver/:resolverId/*";
const PUBLIC_LOCATED_ROUTE = "/v1/public/:spaceId/delivery/located/:sourceId/:capability";
const PRIVATE_ROUTE = "/v1/private/:spaceId/delivery/:capability";
const DELIVERY_METHODS = ["GET", "HEAD"] as const;

function rejectQuery(requestUrl: string): void {
  if (new URL(requestUrl).search !== "") {
    throw new ProtocolError("query_invalid", "Source Delivery does not accept query parameters");
  }
}

export function registerSourceDeliveryRoutes(app: EdgeApp): void {
  spaceRoute(
    app,
    { methods: DELIVERY_METHODS, path: PUBLIC_RESOLVER_ROUTE, routeClass: "public" },
    async (context, { spaceId, policy }) => {
      rejectQuery(context.req.url);
      const resolverId = context.req.param("resolverId") ?? "";
      const resolver = policy.resolvers.find((candidate) => candidate.id === resolverId);
      if (resolver === undefined || resolver.type !== "uploadthing") return notFound();
      const sourceRef = resolverSourceRef(context.req.url, resolverId);
      if (sourceRef === undefined) return notFound();
      const source = resolveUploadThingSource(sourceRef, resolver.allowedProjectIds);
      if (source === undefined) return notFound();
      return deliverSource({
        executionCtx: context.executionCtx,
        request: context.req.raw,
        identity: { routeClass: "public", spaceId, sourceId: source.sourceId },
        locator: source.sourceUrl,
      });
    },
  );

  spaceRoute(
    app,
    { methods: DELIVERY_METHODS, path: PUBLIC_LOCATED_ROUTE, routeClass: "public" },
    async (context, { spaceId, policy, snapshot }) => {
      rejectQuery(context.req.url);
      const sourceId = context.req.param("sourceId") ?? "";
      const claims = await verifySourceCapability(context.req.param("capability") ?? "", {
        spaceId,
        expectedPurpose: "source_delivery",
        expectedSourceId: sourceId,
        keys: snapshot.keysFor(spaceId),
        now: Math.floor(Date.now() / 1000),
        allowedSourceOrigins: policy.allowedSourceOrigins,
      });
      return deliverSource({
        executionCtx: context.executionCtx,
        request: context.req.raw,
        identity: { routeClass: "public", spaceId, sourceId },
        locator: claims.locator,
      });
    },
  );

  spaceRoute(
    app,
    { methods: DELIVERY_METHODS, path: PRIVATE_ROUTE, routeClass: "private" },
    async (context, { spaceId, policy, snapshot }) => {
      rejectQuery(context.req.url);
      const claims = await verifySourceCapability(context.req.param("capability") ?? "", {
        spaceId,
        expectedPurpose: "source_delivery",
        keys: snapshot.keysFor(spaceId),
        now: Math.floor(Date.now() / 1000),
        allowedSourceOrigins: policy.allowedSourceOrigins,
      });
      return deliverSource({
        executionCtx: context.executionCtx,
        request: context.req.raw,
        identity: { routeClass: "private", spaceId, sourceId: claims.source_id },
        locator: claims.locator,
      });
    },
  );

  for (const route of [PUBLIC_RESOLVER_ROUTE, PUBLIC_LOCATED_ROUTE, PRIVATE_ROUTE]) {
    app.all(route, () => methodNotAllowed());
  }
}
