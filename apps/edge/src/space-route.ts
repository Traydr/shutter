import type { ParsedEdgeConfigSnapshot, RouteClass, SpacePolicy } from "@shutter/protocol";
import type { Context, Hono } from "hono";
import { getEdgeConfig } from "./config-snapshot.js";
import { notFound, protocolFailure } from "./http-responses.js";

type EdgeEnv = { Bindings: CloudflareBindings };

export interface SpaceRouteAccess {
  spaceId: string;
  policy: SpacePolicy;
  snapshot: ParsedEdgeConfigSnapshot;
}

/**
 * Every Space-scoped Edge route runs the same prologue: resolve the config
 * snapshot, look up the Space, and enforce its route class before any other
 * work. That guard is what keeps private Spaces off public routes, so it lives
 * here once instead of being re-typed per handler. The helper also owns the
 * try/catch boundary that maps protocol errors to responses.
 */
export function spaceRoute(
  app: Hono<EdgeEnv>,
  options: { methods: readonly string[]; path: string; routeClass: RouteClass },
  handler: (context: Context<EdgeEnv>, access: SpaceRouteAccess) => Promise<Response>,
): void {
  app.on([...options.methods], options.path, async (context) => {
    try {
      // The path is a runtime string, so Hono cannot name its parameters; on
      // any path the parameter record is a string-to-string map.
      const params: Record<string, string> = context.req.param();
      const spaceId = params.spaceId;
      if (spaceId === undefined || spaceId === "") return notFound();
      const snapshot = await getEdgeConfig(context.env, context.executionCtx);
      const policy = snapshot.policyFor(spaceId);
      if (policy === undefined || policy.routeClass !== options.routeClass) return notFound();
      return await handler(context, { spaceId, policy, snapshot });
    } catch (error) {
      return protocolFailure(error);
    }
  });
}
