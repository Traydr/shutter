import { randomUUID } from "node:crypto";
import {
  CONTROL_HTTP_ROUTES,
  type ControlHttpRoute,
  type JsonValue,
  parseEdgeConfigRefreshReport,
  serializeEdgeConfigSnapshot,
} from "@shutter/protocol";
import { Hono } from "hono";
import { matchedRoutes } from "hono/route";
import { type AdminRuntime, createAdminApp } from "./admin/app.js";
import type { EdgeRefreshTracker } from "./edge-refresh-status.js";
import type { ImgproxyConfig } from "./imgproxy.js";
import { createJobApi, type JobApiRuntime } from "./job-api.js";
import { type ControlLogger, operationalErrorType } from "./logging.js";
import type { MasterStore } from "./master-store.js";
import { registerOptimizeRoutes } from "./optimize-routes.js";
import { bearerAuthorized } from "./origin-auth.js";
import type { SpaceRegistry } from "./spaces/registry.js";

export interface ControlRuntimeConfig {
  logger: ControlLogger;
  originAuthToken(): string | undefined;
  edgeConfigToken?(): string | undefined;
  adminBootstrapToken?(): string | undefined;
  imgproxyAllowedSources?(): string | undefined;
  imgproxyConfig(): ImgproxyConfig | undefined;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  masterStore?: MasterStore;
  jobApiRuntime?: JobApiRuntime;
  spaceRegistry?: SpaceRegistry;
  edgeRefreshTracker?: EdgeRefreshTracker;
}

function safeRouteTemplate(
  context: Parameters<typeof matchedRoutes>[0],
): ControlHttpRoute | "<unmatched>" {
  const matchedRoute = matchedRoutes(context)
    .map((matched) => matched.path)
    .filter((path) => path !== "*" && path !== "/*")
    .at(-1);
  return (
    Object.values(CONTROL_HTTP_ROUTES).find((route) => route === matchedRoute) ?? "<unmatched>"
  );
}

function unavailable(): Response {
  return Response.json(
    { error: { code: "service_unavailable" } },
    { status: 503, headers: { "cache-control": "private, no-store" } },
  );
}

export function createControlApp(
  runtime: ControlRuntimeConfig,
): Hono<{ Variables: { requestId: string } }> {
  const control = new Hono<{ Variables: { requestId: string } }>();

  control.use("*", async (context, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    context.set("requestId", requestId);
    try {
      await next();
    } finally {
      // Stamped on the final response rather than through prepared headers so
      // a handler that returns a raw Response still carries the request ID.
      context.res.headers.set("x-request-id", requestId);
      const matchedRoute = safeRouteTemplate(context);
      if (matchedRoute !== CONTROL_HTTP_ROUTES.healthz) {
        const status = context.res.status;
        runtime.logger.emit(status >= 500 ? "error" : "info", {
          event: "control.http.completed",
          requestId,
          httpMethod: context.req.method,
          httpRoute: matchedRoute,
          httpStatusCode: status,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          outcome: status >= 400 ? "failed" : "ready",
        });
      }
    }
  });

  // An unhandled error is a code defect, not a retry-me signal: 500, not 503.
  // The registry-failure paths return their explicit 503s themselves.
  control.onError((error, context) => {
    runtime.logger.emit("error", {
      event: "control.service.failed",
      requestId: context.get("requestId"),
      httpRoute: safeRouteTemplate(context),
      outcome: "failed",
      errorType: operationalErrorType(error),
    });
    return context.json({ error: { code: "internal_error" } }, 500, {
      "cache-control": "private, no-store",
    });
  });

  control.get(CONTROL_HTTP_ROUTES.healthz, (context) =>
    context.json({ ok: true, service: "control" }),
  );
  control.get(CONTROL_HTTP_ROUTES.edgeConfig, async (context) => {
    if (!bearerAuthorized(context.req.header("authorization"), runtime.edgeConfigToken?.())) {
      return context.json({ error: { code: "unauthorized" } }, 401, {
        "cache-control": "private, no-store",
        "www-authenticate": "Bearer",
      });
    }
    if (runtime.spaceRegistry === undefined) {
      return context.json({ error: { code: "service_unavailable" } }, 503, {
        "cache-control": "private, no-store",
      });
    }
    try {
      const snapshot = await runtime.spaceRegistry.loadEdgeSnapshot();
      return context.json(serializeEdgeConfigSnapshot(snapshot, new Date()), 200, {
        "cache-control": "private, no-store",
      });
    } catch {
      return context.json({ error: { code: "service_unavailable" } }, 503, {
        "cache-control": "private, no-store",
      });
    }
  });
  control.post(CONTROL_HTTP_ROUTES.edgeConfigRefresh, async (context) => {
    if (!bearerAuthorized(context.req.header("authorization"), runtime.edgeConfigToken?.())) {
      return context.json({ error: { code: "unauthorized" } }, 401, {
        "cache-control": "private, no-store",
        "www-authenticate": "Bearer",
      });
    }
    if (runtime.edgeRefreshTracker === undefined) return unavailable();
    let body: JsonValue;
    try {
      if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new Error("invalid content type");
      }
      body = await context.req.json();
    } catch {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }
    let report: ReturnType<typeof parseEdgeConfigRefreshReport>;
    try {
      report = parseEdgeConfigRefreshReport(body);
    } catch {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }
    runtime.edgeRefreshTracker.report(report.generation);
    return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  });
  const adminOptions: AdminRuntime = {
    bootstrapToken: () => runtime.adminBootstrapToken?.(),
    imgproxyAllowedSources: () => runtime.imgproxyAllowedSources?.(),
    edgeRefreshStatus: () => runtime.edgeRefreshTracker?.latest(),
  };
  if (runtime.spaceRegistry !== undefined) adminOptions.registry = runtime.spaceRegistry;
  control.route("/admin", createAdminApp(adminOptions));
  if (runtime.jobApiRuntime !== undefined) {
    control.route("/", createJobApi(runtime.jobApiRuntime));
  } else {
    for (const route of [
      CONTROL_HTTP_ROUTES.sourcePurge,
      CONTROL_HTTP_ROUTES.previewJob,
      CONTROL_HTTP_ROUTES.executorClaim,
      CONTROL_HTTP_ROUTES.executorHeartbeat,
      CONTROL_HTTP_ROUTES.executorComplete,
      CONTROL_HTTP_ROUTES.executorFail,
    ]) {
      control.all(route, () => unavailable());
    }
  }

  registerOptimizeRoutes(control, runtime);

  return control;
}
