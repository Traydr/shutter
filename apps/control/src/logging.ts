import { type LogAttributes, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import { type OperationalEvent, sanitizeOperationalEvent } from "@shutter/protocol";
import pino, { type DestinationStream, type Logger } from "pino";
import { env } from "./env/server.js";
import { type ControlLoggingEnvironment, readOtlpLogsConfig } from "./logging-config.js";

export { operationalErrorType } from "@shutter/protocol";
export type { ControlLoggingEnvironment } from "./logging-config.js";

export type OperationalLogLevel = "info" | "error";

export interface ControlLogger {
  emit(level: OperationalLogLevel, event: OperationalEvent): void;
  shutdown(): Promise<void>;
}

export interface ControlLoggerDependencies {
  stdout?: DestinationStream;
  packageVersion?: string;
  now?: () => number;
  batchDelayMillis?: number;
  allowedOtlpEndpoints?: readonly string[];
}

function createStdoutLogger(stdout?: DestinationStream): Logger {
  return pino(
    {
      base: { service: "shutter-control" },
    },
    stdout,
  );
}

function resourceAttributes(
  environment: ControlLoggingEnvironment,
  packageVersion: string,
): Record<string, string> {
  return {
    "service.name": "shutter-control",
    "service.namespace": "shutter",
    "service.version": environment.RAILWAY_GIT_COMMIT_SHA ?? packageVersion,
    "deployment.environment.name":
      environment.RAILWAY_ENVIRONMENT_NAME ?? environment.NODE_ENV ?? "development",
    ...(environment.RAILWAY_REPLICA_ID === undefined
      ? {}
      : { "service.instance.id": environment.RAILWAY_REPLICA_ID }),
    ...(environment.RAILWAY_REPLICA_REGION === undefined
      ? {}
      : { "cloud.region": environment.RAILWAY_REPLICA_REGION }),
    ...(environment.RAILWAY_DEPLOYMENT_ID === undefined
      ? {}
      : { "railway.deployment.id": environment.RAILWAY_DEPLOYMENT_ID }),
  };
}

type OptionalOperationalEventField = Exclude<keyof OperationalEvent, "event">;

const EVENT_FIELD_PROJECTIONS = {
  sourceHash: "shutter.source.hash",
  processingTokenHash: "shutter.processing_token.hash",
  routeClass: "shutter.route_class",
  cacheOutcome: "shutter.cache.outcome",
  mediaClass: "shutter.media.class",
  byteRangeOutcome: "shutter.byte_range.outcome",
  originFetchResult: "shutter.origin_fetch.result",
  kind: "shutter.derivative.kind",
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
  attributes: LogAttributes;
} {
  const stdout: Record<string, string | number> = { event: event.event };
  const attributes: LogAttributes = { "event.name": event.event };
  for (const field of Object.keys(EVENT_FIELD_PROJECTIONS) as OptionalOperationalEventField[]) {
    const value = event[field];
    if (value !== undefined) {
      stdout[field] = value;
      attributes[EVENT_FIELD_PROJECTIONS[field]] = value;
    }
  }
  return { stdout, attributes };
}

function reportingExporter(
  exporter: OTLPLogExporter,
  stdout: Logger,
  now: () => number,
): LogRecordExporter {
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let failuresSinceReport = 0;
  return {
    export(records, callback) {
      exporter.export(records, (result) => {
        if (result.code !== 0) {
          failuresSinceReport += 1;
          const currentTime = now();
          if (currentTime - lastReportAt >= 60_000) {
            stdout.error({
              event: "control.telemetry.export_failed",
              outcome: "failed",
              failureCode: "service_unavailable",
              count: failuresSinceReport,
            });
            failuresSinceReport = 0;
            lastReportAt = currentTime;
          }
        }
        callback(result);
      });
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
  };
}

export function createControlLogger(
  environment: ControlLoggingEnvironment,
  dependencies: ControlLoggerDependencies = {},
): ControlLogger {
  const stdout = createStdoutLogger(dependencies.stdout);
  let provider: LoggerProvider | undefined;
  let otelLogger: ReturnType<LoggerProvider["getLogger"]> | undefined;

  if (environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT !== undefined) {
    try {
      const config = readOtlpLogsConfig(environment, dependencies.allowedOtlpEndpoints);
      if (config === undefined) throw new Error("missing OTLP configuration");
      const exporter = new OTLPLogExporter({
        url: config.endpoint,
        headers: config.headers,
        timeoutMillis: config.timeoutMillis,
      });
      provider = new LoggerProvider({
        resource: resourceFromAttributes(
          resourceAttributes(environment, dependencies.packageVersion ?? "0.1.0"),
        ),
        processors: [
          new BatchLogRecordProcessor({
            exporter: reportingExporter(exporter, stdout, dependencies.now ?? Date.now),
            maxExportBatchSize: 512,
            maxQueueSize: 2_048,
            scheduledDelayMillis: dependencies.batchDelayMillis ?? 1_000,
            exportTimeoutMillis: config.timeoutMillis,
          }),
        ],
      });
      otelLogger = provider.getLogger("shutter-control", dependencies.packageVersion ?? "0.1.0");
    } catch {
      stdout.error({
        event: "control.telemetry.configuration_failed",
        outcome: "failed",
        failureCode: "service_unavailable",
        errorType: "ConfigurationError",
      });
    }
  }

  let shutdown: Promise<void> | undefined;

  return {
    emit(level, event) {
      const sanitized = sanitizeOperationalEvent(event);
      const projected = projectEvent(sanitized);
      stdout[level](projected.stdout);
      otelLogger?.emit({
        eventName: sanitized.event,
        severityNumber: level === "info" ? SeverityNumber.INFO : SeverityNumber.ERROR,
        severityText: level === "info" ? "INFO" : "ERROR",
        body: sanitized.event,
        attributes: projected.attributes,
      });
    },
    shutdown() {
      shutdown ??= provider?.shutdown() ?? Promise.resolve();
      return shutdown;
    },
  };
}

export const controlLogger = createControlLogger(env, {
  packageVersion: env.npm_package_version ?? "0.1.0",
});
