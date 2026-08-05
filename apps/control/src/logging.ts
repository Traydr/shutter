import { type OperationalEvent, sanitizeOperationalEvent } from "@shutter/protocol";
import { Context, Effect, Layer, Logger, References } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { ControlConfig, type ControlConfigShape } from "./env/server.js";
import { type ControlLoggingEnvironment, readOtlpLogsConfig } from "./logging-config.js";

export { operationalErrorType } from "@shutter/protocol";
export type { ControlLoggingEnvironment } from "./logging-config.js";

export type OperationalLogLevel = "info" | "error";

// Preserve the shutdown budget previously enforced by shutdown.ts. Effect's
// OTLP exporter applies this timeout to its scoped flush finalizer.
export const CONTROL_LOG_FLUSH_BUDGET_MS = 5_500;

export interface ControlLoggerShape {
  emit(level: OperationalLogLevel, event: OperationalEvent): Effect.Effect<void>;
}

export class ControlLogger extends Context.Service<ControlLogger, ControlLoggerShape>()(
  "@shutter/control/ControlLogger",
) {}

export interface ControlLoggerDependencies {
  stdout?: { write(chunk: string): unknown };
  packageVersion?: string;
  allowedOtlpEndpoints?: readonly string[];
}

type OptionalOperationalEventField = Exclude<keyof OperationalEvent, "event">;

const EVENT_FIELD_PROJECTIONS = {
  sourceHash: "shutter.source.hash",
  processingTokenHash: "shutter.processing_token.hash",
  routeClass: "shutter.route_class",
  cacheOutcome: "shutter.cache.outcome",
  kind: "shutter.rendition.kind",
  executionCycle: "shutter.execution.cycle",
  attemptNumber: "shutter.attempt.number",
  durationMs: "shutter.duration_ms",
  outcome: "shutter.outcome",
  failureCode: "shutter.failure.code",
  count: "shutter.count",
  requestId: "request.id",
  httpMethod: "http.request.method",
  httpRoute: "http.route",
  httpStatusCode: "http.response.status_code",
  errorType: "error.type",
} satisfies Record<OptionalOperationalEventField, string>;

function projectEvent(event: OperationalEvent): {
  stdout: Record<string, string | number>;
  attributes: Record<string, string | number>;
} {
  const stdout: Record<string, string | number> = { event: event.event };
  const attributes: Record<string, string | number> = { "event.name": event.event };
  for (const field of Object.keys(EVENT_FIELD_PROJECTIONS) as OptionalOperationalEventField[]) {
    const value = event[field];
    if (value !== undefined) {
      stdout[field] = value;
      attributes[EVENT_FIELD_PROJECTIONS[field]] = value;
    }
  }
  return { stdout, attributes };
}

function makeControlLogger(): ControlLoggerShape {
  return ControlLogger.of({
    emit(level, event) {
      const projected = projectEvent(sanitizeOperationalEvent(event));
      return Effect.logWithLevel(level === "info" ? "Info" : "Error")(event.event).pipe(
        Effect.annotateLogs(projected.attributes),
      );
    },
  });
}

function makeStdoutLogger(stdout: { write(chunk: string): unknown }): Logger.Logger<unknown, void> {
  return Logger.make((options) => {
    const message = Array.isArray(options.message) ? options.message[0] : options.message;
    if (typeof message !== "string" || !message.includes(".")) return;
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    const projected: Record<string, string | number> = { event: message };
    for (const field of Object.keys(EVENT_FIELD_PROJECTIONS) as OptionalOperationalEventField[]) {
      const value = annotations[EVENT_FIELD_PROJECTIONS[field]];
      if (typeof value === "string" || typeof value === "number") projected[field] = value;
    }
    stdout.write(
      `${JSON.stringify({
        level: options.logLevel === "Error" ? 50 : 30,
        time: options.date.getTime(),
        service: "shutter-control",
        ...projected,
      })}\n`,
    );
  });
}

function loggingEnvironment(config: ControlConfigShape): ControlLoggingEnvironment {
  return {
    nodeEnv: config.nodeEnv,
    otlpLogsAllowedEndpoints: config.otlpLogsAllowedEndpoints,
    otlpLogsEndpoint: config.otlpLogsEndpoint,
    otlpLogsHeaders: config.otlpLogsHeaders,
    otlpLogsProtocol: config.otlpLogsProtocol,
    otlpLogsTimeout: config.otlpLogsTimeout,
    railwayDeploymentId: config.railwayDeploymentId,
    railwayEnvironmentName: config.railwayEnvironmentName,
    railwayGitCommitSha: config.railwayGitCommitSha,
    railwayReplicaId: config.railwayReplicaId,
    railwayReplicaRegion: config.railwayReplicaRegion,
  };
}

function resource(config: ControlConfigShape, packageVersion: string) {
  return {
    serviceName: "shutter-control",
    serviceVersion: config.railwayGitCommitSha ?? packageVersion,
    attributes: {
      "service.namespace": "shutter",
      "deployment.environment.name": config.railwayEnvironmentName ?? config.nodeEnv,
      ...(config.railwayReplicaId === undefined
        ? {}
        : { "service.instance.id": config.railwayReplicaId }),
      ...(config.railwayReplicaRegion === undefined
        ? {}
        : { "cloud.region": config.railwayReplicaRegion }),
      ...(config.railwayDeploymentId === undefined
        ? {}
        : { "railway.deployment.id": config.railwayDeploymentId }),
    },
  };
}

export function makeControlLoggingLayer(
  config: ControlConfigShape,
  dependencies: ControlLoggerDependencies = {},
) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stdoutLayer = Logger.layer([makeStdoutLogger(stdout)]);
  const controlLogger = makeControlLogger();
  const serviceLayer = Layer.succeed(ControlLogger)(controlLogger);
  const packageVersion = dependencies.packageVersion ?? config.packageVersion ?? "0.1.0";

  let telemetryLayer = Layer.empty;
  let configurationFailed = false;
  if (config.otlpLogsEndpoint !== undefined) {
    try {
      const otlp = readOtlpLogsConfig(
        loggingEnvironment(config),
        dependencies.allowedOtlpEndpoints,
      );
      if (otlp === undefined) throw new Error("missing OTLP configuration");
      const common = {
        resource: resource(config, packageVersion),
        headers: otlp.headers,
        shutdownTimeout: `${CONTROL_LOG_FLUSH_BUDGET_MS} millis`,
      } as const;
      const tracesUrl = otlp.endpoint.replace(/\/v1\/logs\/?$/u, "/v1/traces");
      telemetryLayer = Layer.merge(
        OtlpLogger.layer({
          url: otlp.endpoint,
          ...common,
          maxBatchSize: 512,
          exportInterval: "1 second",
          mergeWithExisting: true,
        }),
        OtlpTracer.layer({ url: tracesUrl, ...common }),
      ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));
    } catch {
      configurationFailed = true;
    }
  }

  const diagnosticLayer = configurationFailed
    ? Layer.effectDiscard(
        controlLogger.emit("error", {
          event: "control.telemetry.configuration_failed",
          outcome: "failed",
          failureCode: "service_unavailable",
          errorType: "ConfigurationError",
        }),
      )
    : Layer.empty;

  return Layer.mergeAll(serviceLayer, telemetryLayer, diagnosticLayer).pipe(
    Layer.provideMerge(stdoutLayer),
  );
}

export const ControlLoggingLive = Layer.unwrap(
  Effect.map(ControlConfig, (config) => makeControlLoggingLayer(config)),
);
