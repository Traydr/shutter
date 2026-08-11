import { operationalErrorType } from "@shutter/protocol";
import { Cause, Effect, Exit, Layer, Logger, References, Tracer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpMiddleware } from "effect/unstable/http";
import {
  OtlpExporter,
  OtlpLogger,
  OtlpSerialization,
  OtlpTracer,
} from "effect/unstable/observability";

const EXPORT_INTERVAL = "1 second";
const MAX_BATCH_SIZE = 512;
const MAX_QUEUE_SIZE = 2_048;
const SAFE_HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const SAFE_SPAN_ATTRIBUTE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

interface ControlTelemetryOptions {
  logsUrl: string;
  tracesUrl: string;
  resource: Parameters<typeof OtlpLogger.make>[0]["resource"];
  headers: Parameters<typeof OtlpLogger.make>[0]["headers"];
  timeoutMillis: number;
  shutdownTimeout: Parameters<typeof OtlpLogger.make>[0]["shutdownTimeout"];
  sanitizedEventAnnotation: string;
  allowedLogAttributes: readonly string[];
  reportExportFailure: () => Effect.Effect<void>;
}

function httpClientLayer(timeoutMillis: number, reportExportFailure: () => Effect.Effect<void>) {
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.transform(HttpClient.filterStatusOk(client), (response, request) =>
        response.pipe(
          Effect.timeout(timeoutMillis),
          Effect.mapError((error) =>
            HttpClientError.isHttpClientError(error)
              ? error
              : new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    description: "telemetry export timed out",
                  }),
                }),
          ),
          Effect.tapError(reportExportFailure),
        ),
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

function snapshotLogOptions(
  options: Logger.Options<unknown>,
  allowedAttributes: readonly string[],
): Logger.Options<unknown> {
  const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
  const allowedAnnotations: Record<string, unknown> = {};
  for (const attribute of allowedAttributes) {
    const value = annotations[attribute];
    if (typeof value === "string" || typeof value === "number") {
      allowedAnnotations[attribute] = value;
    }
  }
  const currentSpan = options.fiber.currentSpan;
  const fiber = new Proxy(options.fiber, {
    get(target, property, receiver) {
      if (property === "currentSpan") return currentSpan;
      if (property === "getRef") {
        return (reference: unknown) =>
          reference === References.CurrentLogAnnotations
            ? allowedAnnotations
            : Reflect.apply(target.getRef, target, [reference]);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { ...options, fiber };
}

function queuedLogger(
  options: Parameters<typeof OtlpLogger.make>[0],
  sanitizedEventAnnotation: string,
  allowedAttributes: readonly string[],
) {
  return Effect.gen(function* () {
    const otlp = yield* OtlpLogger.make(options);
    const queue: Logger.Options<unknown>[] = [];
    const drain = (limit: number) =>
      Effect.sync(() => {
        for (const record of queue.splice(0, limit)) otlp.log(record);
      });

    yield* Effect.addFinalizer(() => drain(queue.length));
    yield* Effect.sleep(EXPORT_INTERVAL).pipe(
      Effect.andThen(drain(MAX_BATCH_SIZE)),
      Effect.forever,
      Effect.forkScoped,
    );

    return Logger.make<unknown, void>((record) => {
      const annotations = record.fiber.getRef(References.CurrentLogAnnotations);
      if (annotations[sanitizedEventAnnotation] !== true || queue.length >= MAX_QUEUE_SIZE) return;
      queue.push(snapshotLogOptions(record, allowedAttributes));
    });
  });
}

function safeSpanName(name: string, kind: Tracer.SpanKind): string {
  if (name === "sql.execute") return name;
  if (/^http\.(?:client|server) (?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/u.test(name)) {
    return name;
  }
  return `${kind}.operation`;
}

function safeSpanExit(exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return exit;
  const error = new Error("");
  error.name = operationalErrorType(Cause.squash(exit.cause));
  delete error.stack;
  return Exit.fail(error);
}

function redactedTracer(tracer: Tracer.Tracer): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = tracer.span({
        ...options,
        name: safeSpanName(options.name, options.kind),
        links: [],
      });
      return {
        _tag: "Span",
        name: span.name,
        spanId: span.spanId,
        traceId: span.traceId,
        parent: span.parent,
        annotations: span.annotations,
        get status() {
          return span.status;
        },
        attributes: span.attributes,
        links: span.links,
        sampled: span.sampled,
        kind: span.kind,
        end: (endTime, exit) => span.end(endTime, safeSpanExit(exit)),
        attribute(key, value) {
          if (
            key === "http.request.method" &&
            typeof value === "string" &&
            SAFE_HTTP_METHODS.has(value)
          ) {
            span.attribute(key, value);
          } else if (
            key === "http.response.status_code" &&
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= 100 &&
            value <= 599
          ) {
            span.attribute(key, value);
          } else if (
            key === "db.operation.name" &&
            typeof value === "string" &&
            SAFE_SPAN_ATTRIBUTE.test(value)
          ) {
            span.attribute(key, value);
          } else if (key === "url.scheme" && (value === "http" || value === "https")) {
            span.attribute(key, value);
          }
        },
        event() {
          // Span events are unrestricted and are therefore not exported.
        },
        addLinks() {
          // Span link attributes are unrestricted and are therefore not exported.
        },
      };
    },
    context: tracer.context,
  });
}

export function makeControlTelemetryLayer(options: ControlTelemetryOptions) {
  const common = {
    resource: options.resource,
    headers: options.headers,
    shutdownTimeout: options.shutdownTimeout,
  };
  const loggerLayer = Logger.layer(
    [
      queuedLogger(
        {
          url: options.logsUrl,
          ...common,
          maxBatchSize: MAX_BATCH_SIZE,
          exportInterval: EXPORT_INTERVAL,
          excludeLogSpans: true,
        },
        options.sanitizedEventAnnotation,
        options.allowedLogAttributes,
      ),
    ],
    { mergeWithExisting: true },
  ).pipe(Layer.provideMerge(OtlpExporter.layerFlusher));
  const tracerLayer = Layer.effect(
    Tracer.Tracer,
    Effect.map(
      OtlpTracer.make({
        url: options.tracesUrl,
        ...common,
        maxBatchSize: MAX_BATCH_SIZE,
      }),
      redactedTracer,
    ),
  ).pipe(Layer.provideMerge(OtlpExporter.layerFlusher));
  const httpTracingLayer = Layer.mergeAll(
    Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
      (request) => request.url.split("?", 1)[0] === "/healthz",
    ),
    Layer.succeed(HttpMiddleware.SpanNameGenerator)((request) => {
      const method = SAFE_HTTP_METHODS.has(request.method) ? request.method : "OTHER";
      return `http.server ${method}`;
    }),
  );

  return Layer.mergeAll(loggerLayer, tracerLayer, httpTracingLayer).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(httpClientLayer(options.timeoutMillis, options.reportExportFailure)),
  );
}
