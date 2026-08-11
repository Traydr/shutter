import { type OperationalEvent, sanitizeOperationalEvent } from "@shutter/protocol";
import { Context, Effect, Layer, Logger, References } from "effect";
import { makeControlTelemetryLayer } from "./control-telemetry.js";
import { ControlConfig, type ControlConfigShape } from "./env/server.js";
import { type ControlLoggingEnvironment, readOtlpLogsConfig } from "./logging-config.js";

export { operationalErrorType } from "@shutter/protocol";
export type { ControlLoggingEnvironment } from "./logging-config.js";

export type OperationalLogLevel = "info" | "error";

// Preserve the shutdown budget previously enforced by shutdown.ts. Effect's
// OTLP exporter applies this timeout to its scoped flush finalizer.
export const CONTROL_LOG_FLUSH_BUDGET_MS = 5_500;
const EXPORT_FAILURE_REPORT_INTERVAL_MS = 60_000;
const SANITIZED_EVENT_ANNOTATION = "shutter.control.sanitized";

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
  now?: () => number;
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
      const sanitized = sanitizeOperationalEvent(event);
      const projected = projectEvent(sanitized);
      return Effect.logWithLevel(level === "info" ? "Info" : "Error")(sanitized.event).pipe(
        Effect.annotateLogs({
          ...projected.attributes,
          [SANITIZED_EVENT_ANNOTATION]: true,
        }),
      );
    },
  });
}

function writeStdoutEvent(
  stdout: { write(chunk: string): unknown },
  time: number,
  level: number,
  event: Record<string, string | number>,
): void {
  stdout.write(
    `${JSON.stringify({
      level,
      time,
      service: "shutter-control",
      ...event,
    })}\n`,
  );
}

function makeStdoutLogger(stdout: { write(chunk: string): unknown }): Logger.Logger<unknown, void> {
  return Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    if (annotations[SANITIZED_EVENT_ANNOTATION] !== true) return;
    const message = Array.isArray(options.message) ? options.message[0] : options.message;
    if (typeof message !== "string") return;
    const projected: Record<string, string | number> = { event: message };
    for (const field of Object.keys(EVENT_FIELD_PROJECTIONS) as OptionalOperationalEventField[]) {
      const value = annotations[EVENT_FIELD_PROJECTIONS[field]];
      if (typeof value === "string" || typeof value === "number") projected[field] = value;
    }
    writeStdoutEvent(
      stdout,
      options.date.getTime(),
      options.logLevel === "Error" ? 50 : 30,
      projected,
    );
  });
}

function makeExportFailureReporter(
  stdout: { write(chunk: string): unknown },
  now: () => number,
): () => Effect.Effect<void> {
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let failuresSinceReport = 0;
  return () =>
    Effect.sync(() => {
      failuresSinceReport += 1;
      const currentTime = now();
      if (currentTime - lastReportAt < EXPORT_FAILURE_REPORT_INTERVAL_MS) return;
      const event = projectEvent(
        sanitizeOperationalEvent({
          event: "control.telemetry.export_failed",
          outcome: "failed",
          failureCode: "service_unavailable",
          count: failuresSinceReport,
        }),
      ).stdout;
      writeStdoutEvent(stdout, currentTime, 50, event);
      failuresSinceReport = 0;
      lastReportAt = currentTime;
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
      const tracesUrl = otlp.endpoint.replace(/\/v1\/logs\/?$/u, "/v1/traces");
      const reportExportFailure = makeExportFailureReporter(stdout, dependencies.now ?? Date.now);
      telemetryLayer = makeControlTelemetryLayer({
        logsUrl: otlp.endpoint,
        tracesUrl,
        resource: resource(config, packageVersion),
        headers: otlp.headers,
        timeoutMillis: otlp.timeoutMillis,
        shutdownTimeout: `${CONTROL_LOG_FLUSH_BUDGET_MS} millis`,
        sanitizedEventAnnotation: SANITIZED_EVENT_ANNOTATION,
        allowedLogAttributes: Object.values(EVENT_FIELD_PROJECTIONS),
        reportExportFailure,
      });
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
