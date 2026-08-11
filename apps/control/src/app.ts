import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import {
  buildMasterPreviewKey,
  CONTROL_HTTP_ROUTES,
  type ControlHttpRoute,
  ProtocolError,
  type SpacePolicy,
  serializeEdgeConfigSnapshot,
  validateSourceLocator,
} from "@shutter/protocol";
import { Hono } from "hono";
import { matchedRoutes } from "hono/route";
import { Pool } from "pg";
import { env } from "./env/server.js";
import { createSerializedExecutorDispatch, sendExecutorWake } from "./executor-dispatch.js";
import { buildImgproxyRequest, type ImgproxyConfig } from "./imgproxy.js";
import { createJobApi, type JobApiRuntime } from "./job-api.js";
import { type ControlLogger, controlLogger, operationalErrorType } from "./logging.js";
import { createMasterStore, type MasterStore } from "./master-store.js";
import { PostgresRenditionJobLifecycle } from "./rendition-job-lifecycle.js";
import { createSourcePurge } from "./source-purge.js";
import { CapabilityKeyEncryption } from "./spaces/encryption.js";
import { PostgresSpaceRegistry } from "./spaces/postgres-registry.js";
import type { SpaceRegistry } from "./spaces/registry.js";

const EXECUTOR_WAKE_TIMEOUT_MS = 11 * 60 * 1_000;

export interface ControlRuntimeConfig {
  logger: ControlLogger;
  originAuthToken(): string | undefined;
  edgeConfigToken?(): string | undefined;
  imgproxyConfig(): ImgproxyConfig | undefined;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  masterStore?: MasterStore;
  jobApiRuntime?: JobApiRuntime;
  spaceRegistry?: SpaceRegistry;
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

function credentialDigest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorized(header: string | undefined, expectedToken: string | undefined): boolean {
  if (expectedToken === undefined || expectedToken.length < 32 || header === undefined)
    return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(
    credentialDigest(header.slice(prefix.length)),
    credentialDigest(expectedToken),
  );
}

function isCacheKey(value: string): boolean {
  return (
    value.startsWith("cache/v1/") &&
    value.endsWith(".webp") &&
    !value.includes("..") &&
    !value.includes("\\")
  );
}

function spaceIdFromCacheKey(key: string): string | undefined {
  const segments = key.split("/");
  // cache/v1/{routeClass}/{spaceId}/{fingerprint}/{input}/wN-qN.webp
  if (segments.length < 6 || segments[0] !== "cache" || segments[1] !== "v1") return undefined;
  const routeClass = segments[2];
  const spaceId = segments[3];
  if (
    (routeClass !== "public" && routeClass !== "private") ||
    spaceId === undefined ||
    spaceId.length === 0
  ) {
    return undefined;
  }
  try {
    return decodeURIComponent(spaceId);
  } catch {
    return undefined;
  }
}

function strictPositiveInteger(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function activeSpacePolicy(
  runtime: ControlRuntimeConfig,
  spaceId: string,
): Promise<SpacePolicy | undefined> {
  if (runtime.spaceRegistry === undefined) throw new Error("Space Registry is unavailable");
  return runtime.spaceRegistry.getActiveSpacePolicy(spaceId);
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
    context.header("x-request-id", requestId);
    try {
      await next();
    } finally {
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

  control.onError((error, context) => {
    runtime.logger.emit("error", {
      event: "control.service.failed",
      requestId: context.get("requestId"),
      httpRoute: safeRouteTemplate(context),
      outcome: "failed",
      failureCode: "service_unavailable",
      errorType: operationalErrorType(error),
    });
    return context.json({ error: { code: "service_unavailable" } }, 503, {
      "cache-control": "private, no-store",
    });
  });

  control.get(CONTROL_HTTP_ROUTES.healthz, (context) =>
    context.json({ ok: true, service: "control" }),
  );
  control.get(CONTROL_HTTP_ROUTES.edgeConfig, async (context) => {
    if (!authorized(context.req.header("authorization"), runtime.edgeConfigToken?.())) {
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

  control.get(CONTROL_HTTP_ROUTES.spikeRendition, async (context) => {
    if (!authorized(context.req.header("authorization"), runtime.originAuthToken())) {
      return context.json({ error: { code: "unauthorized" } }, 401, {
        "cache-control": "private, no-store",
        "www-authenticate": "Bearer",
      });
    }

    const query = new URL(context.req.url).searchParams;
    const allowedKeys = new Set(["key", "source", "w", "q"]);
    if (
      [...query.keys()].some((key) => !allowedKeys.has(key)) ||
      [...allowedKeys].some((key) => query.getAll(key).length !== 1)
    ) {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }
    const key = query.get("key");
    const source = query.get("source");
    const width = strictPositiveInteger(query.get("w"));
    const quality = strictPositiveInteger(query.get("q"));
    const imgproxy = runtime.imgproxyConfig();
    const spaceId = key === null ? undefined : spaceIdFromCacheKey(key);
    if (
      key === null ||
      !isCacheKey(key) ||
      spaceId === undefined ||
      source === null ||
      width === undefined ||
      quality === undefined ||
      quality > 100 ||
      imgproxy === undefined
    ) {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }

    let policy: SpacePolicy | undefined;
    try {
      policy = await activeSpacePolicy(runtime, spaceId);
    } catch {
      return context.json({ error: { code: "service_unavailable" } }, 503, {
        "cache-control": "private, no-store",
      });
    }
    if (policy === undefined) {
      return context.json({ error: { code: "not_found" } }, 404, {
        "cache-control": "private, no-store",
      });
    }

    try {
      validateSourceLocator(source, policy.allowedSourceOrigins);
    } catch (error) {
      if (error instanceof ProtocolError) {
        return context.json({ error: { code: error.code } }, 403, {
          "cache-control": "private, no-store",
        });
      }
      throw error;
    }

    try {
      const request = buildImgproxyRequest({ sourceUrl: source, width, quality }, imgproxy);
      runtime.logger.emit("info", {
        event: "control.rendition.delegated",
        outcome: "accepted",
      });
      const response = await runtime.fetch(request.url, {
        headers: request.headers,
        redirect: "error",
      });
      if (!response.ok || response.body === null) {
        runtime.logger.emit("error", {
          event: "control.rendition.failed",
          outcome: "failed",
          failureCode: "service_unavailable",
        });
        return context.json({ error: { code: "rendition_failed" } }, 502, {
          "cache-control": "private, no-store",
        });
      }
      runtime.logger.emit("info", {
        event: "control.rendition.delegated",
        outcome: "ready",
      });
      const headers = new Headers({
        "cache-control": "private, no-store",
        "content-type": response.headers.get("content-type") ?? "image/webp",
        "x-shutter-rendition-key": key,
      });
      return new Response(response.body, { status: 200, headers });
    } catch {
      runtime.logger.emit("error", {
        event: "control.rendition.failed",
        outcome: "failed",
        failureCode: "service_unavailable",
      });
      return context.json({ error: { code: "rendition_failed" } }, 502, {
        "cache-control": "private, no-store",
      });
    }
  });

  control.post(CONTROL_HTTP_ROUTES.masterRendition, async (context) => {
    if (!authorized(context.req.header("authorization"), runtime.originAuthToken())) {
      return context.json({ error: { code: "unauthorized" } }, 401, {
        "cache-control": "private, no-store",
        "www-authenticate": "Bearer",
      });
    }
    let body: unknown;
    try {
      if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json"))
        throw new Error("invalid content type");
      body = await context.req.json();
    } catch {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return context.json({ error: { code: "request_invalid" } }, 400);
    const value = body as Record<string, unknown>;
    const allowed = new Set(["spaceId", "sourceId", "kind", "w", "q"]);
    const width = typeof value.w === "number" ? value.w : undefined;
    const quality = typeof value.q === "number" ? value.q : undefined;
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      typeof value.spaceId !== "string" ||
      typeof value.sourceId !== "string" ||
      (value.kind !== "video" && value.kind !== "pdf") ||
      !Number.isSafeInteger(width) ||
      width === undefined ||
      width <= 0 ||
      !Number.isSafeInteger(quality) ||
      quality === undefined ||
      quality <= 0 ||
      quality > 100 ||
      runtime.masterStore === undefined
    ) {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }
    try {
      if ((await activeSpacePolicy(runtime, value.spaceId)) === undefined) {
        return context.json({ error: { code: "not_found" } }, 404, {
          "cache-control": "private, no-store",
        });
      }
    } catch {
      return context.json({ error: { code: "service_unavailable" } }, 503, {
        "cache-control": "private, no-store",
      });
    }
    try {
      const key = await buildMasterPreviewKey(value.spaceId, value.sourceId, value.kind);
      const sourceUrl = await runtime.masterStore.presignGet(key);
      const imgproxy = runtime.imgproxyConfig();
      if (imgproxy === undefined) throw new Error("imgproxy unavailable");
      const request = buildImgproxyRequest({ sourceUrl, width, quality }, imgproxy);
      runtime.logger.emit("info", {
        event: "control.rendition.delegated",
        kind: value.kind,
        outcome: "accepted",
      });
      const response = await runtime.fetch(request.url, {
        headers: request.headers,
        redirect: "error",
      });
      if (!response.ok || response.body === null) throw new Error("rendition failed");
      runtime.logger.emit("info", {
        event: "control.rendition.delegated",
        kind: value.kind,
        outcome: "ready",
      });
      return new Response(response.body, {
        headers: {
          "cache-control": "private, no-store",
          "content-type": response.headers.get("content-type") ?? "image/webp",
        },
      });
    } catch {
      runtime.logger.emit("error", {
        event: "control.rendition.failed",
        kind: value.kind as "video" | "pdf",
        outcome: "failed",
        failureCode: "service_unavailable",
      });
      return context.json({ error: { code: "rendition_failed" } }, 502, {
        "cache-control": "private, no-store",
      });
    }
  });

  return control;
}

async function sendConfiguredExecutorWake(
  logger: ControlLogger,
  kind: "video" | "pdf",
): Promise<void> {
  const baseUrl = kind === "video" ? env.VIDEO_EXECUTOR_BASE_URL : env.PDF_EXECUTOR_BASE_URL;
  const token = kind === "video" ? env.VIDEO_EXECUTOR_TOKEN : env.PDF_EXECUTOR_TOKEN;
  if (baseUrl === undefined || token === undefined) {
    throw new Error(`${kind} executor dispatch is not configured`);
  }
  logger.emit("info", {
    event: "control.executor.delegated",
    kind,
    outcome: "accepted",
  });
  await sendExecutorWake({
    baseUrl,
    fetch: globalThis.fetch,
    timeoutMs: EXECUTOR_WAKE_TIMEOUT_MS,
    token,
  });
  logger.emit("info", {
    event: "control.executor.delegated",
    kind,
    outcome: "ready",
  });
}

const dispatchExecutor = createSerializedExecutorDispatch((kind) =>
  sendConfiguredExecutorWake(controlLogger, kind),
);

const databaseUrl = env.DATABASE_URL;
const jobPool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
const renditionJobLifecycle =
  jobPool === undefined ? undefined : new PostgresRenditionJobLifecycle(jobPool);
function configuredCapabilityKeyEncryption(): CapabilityKeyEncryption | undefined {
  if (env.SHUTTER_ENCRYPTION_KEY === undefined) return undefined;
  try {
    return new CapabilityKeyEncryption(env.SHUTTER_ENCRYPTION_KEY);
  } catch {
    return undefined;
  }
}
const capabilityKeyEncryption = configuredCapabilityKeyEncryption();
const spaceRegistry =
  jobPool === undefined
    ? undefined
    : new PostgresSpaceRegistry(jobPool, {
        ...(capabilityKeyEncryption === undefined ? {} : { encryption: capabilityKeyEncryption }),
      });
const masterStore =
  env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
    ? createMasterStore({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      })
    : undefined;
const renditionS3 =
  env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
    ? new S3Client({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        forcePathStyle: true,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        },
      })
    : undefined;
const sourcePurge =
  renditionS3 &&
  renditionJobLifecycle &&
  env.S3_BUCKET &&
  env.CLOUDFLARE_ZONE_ID &&
  env.CLOUDFLARE_CACHE_PURGE_TOKEN &&
  env.EDGE_BASE_URL &&
  env.ORIGIN_AUTH_TOKEN
    ? createSourcePurge({
        logger: controlLogger,
        lifecycle: renditionJobLifecycle,
        s3: renditionS3,
        bucket: env.S3_BUCKET,
        cloudflareZoneId: env.CLOUDFLARE_ZONE_ID,
        cloudflareApiToken: env.CLOUDFLARE_CACHE_PURGE_TOKEN,
        edgeBaseUrl: env.EDGE_BASE_URL,
        edgeAuthToken: env.ORIGIN_AUTH_TOKEN,
        fetch: globalThis.fetch,
      })
    : undefined;

export const jobApiRuntime: JobApiRuntime | undefined =
  renditionJobLifecycle === undefined || spaceRegistry === undefined
    ? undefined
    : {
        lifecycle: renditionJobLifecycle,
        now: () => new Date(),
        spaceRegistry,
        executorToken: (kind) =>
          kind === "video" ? env.VIDEO_EXECUTOR_TOKEN : env.PDF_EXECUTOR_TOKEN,
        dispatch: dispatchExecutor,
        logger: controlLogger,
        ...(sourcePurge === undefined ? {} : { sourcePurge }),
      };

export const app = createControlApp({
  logger: controlLogger,
  originAuthToken: () => env.ORIGIN_AUTH_TOKEN,
  edgeConfigToken: () => env.EDGE_CONFIG_TOKEN,
  imgproxyConfig: () => {
    const baseUrl = env.IMGPROXY_BASE_URL;
    const key = env.IMGPROXY_KEY;
    const salt = env.IMGPROXY_SALT;
    const secret = env.IMGPROXY_SECRET;
    return baseUrl && key && salt && secret ? { baseUrl, key, salt, secret } : undefined;
  },
  fetch: globalThis.fetch,
  ...(masterStore === undefined ? {} : { masterStore }),
  ...(jobApiRuntime === undefined ? {} : { jobApiRuntime }),
  ...(spaceRegistry === undefined ? {} : { spaceRegistry }),
});
