import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  buildMasterPreviewKey,
  CONTROL_HTTP_ROUTES,
  type ControlHttpRoute,
  validateSourceLocator,
} from "@shutter/protocol";
import { getSpacePolicy } from "@shutter/space-config";
import { Cause, Data, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { ImgproxyShape } from "./imgproxy.js";
import { createJobRoutes, type JobApiRuntime } from "./job-api.js";
import { type ControlLoggerShape, operationalErrorType } from "./logging.js";
import type { MasterStoreShape } from "./master-store.js";

export class ControlUpstreamError extends Data.TaggedError("ControlUpstreamError")<{
  readonly cause?: unknown;
}> {}

export interface ControlRuntimeConfig {
  logger: ControlLoggerShape;
  originAuthToken(): string | undefined;
  imgproxy: ImgproxyShape;
  fetch: typeof globalThis.fetch;
  masterStore: MasterStoreShape;
  jobApiRuntime?: JobApiRuntime;
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
  const routeClass = segments[2];
  const spaceId = segments[3];
  if (
    segments.length < 6 ||
    segments[0] !== "cache" ||
    segments[1] !== "v1" ||
    (routeClass !== "public" && routeClass !== "private") ||
    spaceId === undefined ||
    spaceId.length === 0
  )
    return undefined;
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

function jsonFailure(status: number, code: string, authenticate = false) {
  return HttpServerResponse.jsonUnsafe(
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

function upstreamFetch(
  fetch: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit,
) {
  return Effect.tryPromise({
    try: (signal) => fetch(input, { ...init, signal }),
    catch: (cause) => new ControlUpstreamError({ cause }),
  });
}

function requestUrl(request: HttpServerRequest.HttpServerRequest): URL {
  return new URL(request.originalUrl);
}

function completionMiddleware(runtime: ControlRuntimeConfig) {
  return HttpRouter.middleware<{ handles: unknown }>()(
    (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const route = yield* HttpRouter.RouteContext;
        const requestId = randomUUID();
        const startedAt = performance.now();
        const response = yield* effect.pipe(
          Effect.catchCause((cause) =>
            runtime.logger
              .emit("error", {
                event: "control.service.failed",
                requestId,
                httpRoute: route.route.path as ControlHttpRoute,
                outcome: "failed",
                failureCode: "service_unavailable",
                errorType: operationalErrorType(Cause.squash(cause)),
              })
              .pipe(Effect.as(jsonFailure(500, "service_unavailable"))),
          ),
        );
        const withRequestId = HttpServerResponse.setHeader(response, "x-request-id", requestId);
        if (route.route.path !== CONTROL_HTTP_ROUTES.healthz) {
          yield* runtime.logger.emit(response.status >= 500 ? "error" : "info", {
            event: "control.http.completed",
            requestId,
            httpMethod: request.method,
            httpRoute: route.route.path as ControlHttpRoute,
            httpStatusCode: response.status,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            outcome: response.status >= 400 ? "failed" : "ready",
          });
        }
        return withRequestId;
      }) as Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        unknown,
        HttpServerRequest.HttpServerRequest | HttpRouter.RouteContext
      >,
  ).layer;
}

export function createControlRoutes(runtime: ControlRuntimeConfig) {
  const spike = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!authorized(request.headers.authorization, runtime.originAuthToken())) {
      return jsonFailure(401, "unauthorized", true);
    }

    const query = requestUrl(request).searchParams;
    const allowedKeys = new Set(["key", "source", "w", "q"]);
    if (
      [...query.keys()].some((key) => !allowedKeys.has(key)) ||
      [...allowedKeys].some((key) => query.getAll(key).length !== 1)
    )
      return jsonFailure(400, "request_invalid");

    const key = query.get("key");
    const source = query.get("source");
    const width = strictPositiveInteger(query.get("w"));
    const quality = strictPositiveInteger(query.get("q"));
    const spaceId = key === null ? undefined : spaceIdFromCacheKey(key);
    const policy = spaceId === undefined ? undefined : getSpacePolicy(spaceId);
    if (
      key === null ||
      !isCacheKey(key) ||
      spaceId === undefined ||
      policy === undefined ||
      source === null ||
      width === undefined ||
      quality === undefined ||
      quality > 100
    )
      return jsonFailure(400, "request_invalid");

    const locator = yield* validateSourceLocator(source, policy.allowedSourceOrigins).pipe(
      Effect.as({ _tag: "Valid" as const }),
      Effect.catch((error) => Effect.succeed({ _tag: "Invalid" as const, error })),
    );
    if (locator._tag === "Invalid") return jsonFailure(403, locator.error.code);

    const result = yield* Effect.gen(function* () {
      const imgproxy = yield* runtime.imgproxy.buildRequest({ sourceUrl: source, width, quality });
      yield* runtime.logger.emit("info", {
        event: "control.rendition.delegated",
        outcome: "accepted",
      });
      const response = yield* upstreamFetch(runtime.fetch, imgproxy.url, {
        headers: imgproxy.headers,
        redirect: "error",
      });
      if (!response.ok || response.body === null) {
        return yield* Effect.fail(new ControlUpstreamError({}));
      }
      yield* runtime.logger.emit("info", {
        event: "control.rendition.delegated",
        outcome: "ready",
      });
      return HttpServerResponse.fromWeb(
        new Response(response.body, {
          status: 200,
          headers: {
            "cache-control": "private, no-store",
            "content-type": response.headers.get("content-type") ?? "image/webp",
            "x-shutter-rendition-key": key,
          },
        }),
      );
    }).pipe(
      Effect.catch((error) =>
        runtime.logger
          .emit("error", {
            event: "control.rendition.failed",
            outcome: "failed",
            failureCode: "service_unavailable",
          })
          .pipe(
            Effect.as(
              jsonFailure(
                "reason" in error && error.reason === "not_configured" ? 503 : 502,
                "reason" in error && error.reason === "not_configured"
                  ? "service_unavailable"
                  : "rendition_failed",
              ),
            ),
          ),
      ),
    );
    return result;
  });

  const master = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!authorized(request.headers.authorization, runtime.originAuthToken())) {
      return jsonFailure(401, "unauthorized", true);
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      return jsonFailure(400, "request_invalid");
    }
    const parsed = yield* request.json.pipe(
      Effect.map((body) => ({ _tag: "Success" as const, body })),
      Effect.catch(() => Effect.succeed({ _tag: "Failure" as const })),
    );
    if (parsed._tag === "Failure") return jsonFailure(400, "request_invalid");
    const body = parsed.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonFailure(400, "request_invalid");
    }
    const value = body as Record<string, unknown>;
    const allowed = new Set(["spaceId", "sourceId", "kind", "w", "q"]);
    const width = typeof value.w === "number" ? value.w : undefined;
    const quality = typeof value.q === "number" ? value.q : undefined;
    if (
      Object.keys(value).some((field) => !allowed.has(field)) ||
      typeof value.spaceId !== "string" ||
      typeof value.sourceId !== "string" ||
      (value.kind !== "video" && value.kind !== "pdf") ||
      width === undefined ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      quality === undefined ||
      !Number.isSafeInteger(quality) ||
      quality <= 0 ||
      quality > 100
    )
      return jsonFailure(400, "request_invalid");

    return yield* Effect.gen(function* () {
      const key = yield* Effect.promise(() =>
        buildMasterPreviewKey(
          value.spaceId as string,
          value.sourceId as string,
          value.kind as "video" | "pdf",
        ),
      );
      const sourceUrl = yield* runtime.masterStore.presignGet(key);
      const imgproxy = yield* runtime.imgproxy.buildRequest({ sourceUrl, width, quality });
      yield* runtime.logger.emit("info", {
        event: "control.rendition.delegated",
        kind: value.kind as "video" | "pdf",
        outcome: "accepted",
      });
      const response = yield* upstreamFetch(runtime.fetch, imgproxy.url, {
        headers: imgproxy.headers,
        redirect: "error",
      });
      if (!response.ok || response.body === null) {
        return yield* Effect.fail(new ControlUpstreamError({}));
      }
      yield* runtime.logger.emit("info", {
        event: "control.rendition.delegated",
        kind: value.kind as "video" | "pdf",
        outcome: "ready",
      });
      return HttpServerResponse.fromWeb(
        new Response(response.body, {
          headers: {
            "cache-control": "private, no-store",
            "content-type": response.headers.get("content-type") ?? "image/webp",
          },
        }),
      );
    }).pipe(
      Effect.catch((error) =>
        runtime.logger
          .emit("error", {
            event: "control.rendition.failed",
            kind: value.kind as "video" | "pdf",
            outcome: "failed",
            failureCode: "service_unavailable",
          })
          .pipe(
            Effect.as(
              jsonFailure(
                "reason" in error && error.reason === "not_configured" ? 503 : 502,
                "reason" in error && error.reason === "not_configured"
                  ? "service_unavailable"
                  : "rendition_failed",
              ),
            ),
          ),
      ),
    );
  });

  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      CONTROL_HTTP_ROUTES.healthz,
      HttpServerResponse.jsonUnsafe({ ok: true, service: "control" }),
    ),
    HttpRouter.add("GET", CONTROL_HTTP_ROUTES.spikeRendition, spike),
    HttpRouter.add("POST", CONTROL_HTTP_ROUTES.masterRendition, master),
    ...(runtime.jobApiRuntime === undefined ? [] : [createJobRoutes(runtime.jobApiRuntime)]),
  );
  return routes.pipe(Layer.provide(completionMiddleware(runtime)));
}

export function createControlApp(runtime: ControlRuntimeConfig) {
  const web = HttpRouter.toWebHandler(createControlRoutes(runtime), { disableLogger: true });
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return web.handler(input instanceof Request ? input : new Request(input, init));
    },
    dispose: web.dispose,
  };
}
