import { type LogAttributes, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import type { OperationalEvent } from "@shutter/protocol";
import pino, { type DestinationStream, type Logger } from "pino";

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
}

export type ControlLoggingEnvironment = Readonly<Record<string, string | undefined>>;

const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

export function operationalErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "NonErrorThrown";
  return SAFE_ERROR_TYPE.test(error.name) ? error.name : "Error";
}

function createStdoutLogger(stdout?: DestinationStream): Logger {
  return pino(
    {
      base: { service: "shutter-control" },
    },
    stdout,
  );
}

function parseHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim() === "") return {};
  const headers: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("invalid OTLP headers");
    const name = decodeURIComponent(entry.slice(0, separator).trim());
    const headerValue = decodeURIComponent(entry.slice(separator + 1).trim());
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || /[\r\n]/u.test(headerValue)) {
      throw new Error("invalid OTLP headers");
    }
    headers[name] = headerValue;
  }
  return headers;
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

function eventAttributes(event: OperationalEvent): LogAttributes {
  return {
    "event.name": event.event,
    ...(event.requestId === undefined ? {} : { "request.id": event.requestId }),
    ...(event.httpMethod === undefined ? {} : { "http.request.method": event.httpMethod }),
    ...(event.httpRoute === undefined ? {} : { "http.route": event.httpRoute }),
    ...(event.httpStatusCode === undefined
      ? {}
      : { "http.response.status_code": event.httpStatusCode }),
    ...(event.errorType === undefined ? {} : { "error.type": event.errorType }),
    ...(event.sourceHash === undefined ? {} : { "shutter.source.hash": event.sourceHash }),
    ...(event.processingTokenHash === undefined
      ? {}
      : { "shutter.processing_token.hash": event.processingTokenHash }),
    ...(event.routeClass === undefined ? {} : { "shutter.route_class": event.routeClass }),
    ...(event.cacheOutcome === undefined ? {} : { "shutter.cache.outcome": event.cacheOutcome }),
    ...(event.kind === undefined ? {} : { "shutter.rendition.kind": event.kind }),
    ...(event.executionCycle === undefined
      ? {}
      : { "shutter.execution.cycle": event.executionCycle }),
    ...(event.attemptNumber === undefined ? {} : { "shutter.attempt.number": event.attemptNumber }),
    ...(event.durationMs === undefined ? {} : { "shutter.duration_ms": event.durationMs }),
    ...(event.outcome === undefined ? {} : { "shutter.outcome": event.outcome }),
    ...(event.failureCode === undefined ? {} : { "shutter.failure.code": event.failureCode }),
    ...(event.count === undefined ? {} : { "shutter.count": event.count }),
  };
}

function stdoutEvent(event: OperationalEvent): OperationalEvent {
  return {
    event: event.event,
    ...(event.sourceHash === undefined ? {} : { sourceHash: event.sourceHash }),
    ...(event.processingTokenHash === undefined
      ? {}
      : { processingTokenHash: event.processingTokenHash }),
    ...(event.routeClass === undefined ? {} : { routeClass: event.routeClass }),
    ...(event.cacheOutcome === undefined ? {} : { cacheOutcome: event.cacheOutcome }),
    ...(event.kind === undefined ? {} : { kind: event.kind }),
    ...(event.executionCycle === undefined ? {} : { executionCycle: event.executionCycle }),
    ...(event.attemptNumber === undefined ? {} : { attemptNumber: event.attemptNumber }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
    ...(event.failureCode === undefined ? {} : { failureCode: event.failureCode }),
    ...(event.count === undefined ? {} : { count: event.count }),
    ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    ...(event.httpMethod === undefined ? {} : { httpMethod: event.httpMethod }),
    ...(event.httpRoute === undefined ? {} : { httpRoute: event.httpRoute }),
    ...(event.httpStatusCode === undefined ? {} : { httpStatusCode: event.httpStatusCode }),
    ...(event.errorType === undefined ? {} : { errorType: event.errorType }),
  };
}

function timeoutMillis(environment: ControlLoggingEnvironment): number {
  const value = environment.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT;
  if (value === undefined) return 5_000;
  if (!/^[1-9]\d*$/u.test(value)) throw new Error("invalid OTLP timeout");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid OTLP timeout");
  return parsed;
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

  const endpoint = environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (endpoint !== undefined) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("invalid OTLP endpoint");
      }
      if (
        environment.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL !== undefined &&
        environment.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL !== "http/json"
      ) {
        throw new Error("unsupported OTLP protocol");
      }
      const headers = parseHeaders(environment.OTEL_EXPORTER_OTLP_LOGS_HEADERS);
      if (url.hostname === "parseable.traydr.dev") {
        const normalized = new Map(
          Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
        );
        if (
          normalized.get("x-p-stream") !== "shutter" ||
          normalized.get("x-p-log-source") !== "otel-logs" ||
          !normalized.get("authorization")?.startsWith("Basic ")
        ) {
          throw new Error("incomplete Parseable headers");
        }
      }
      const exportTimeoutMillis = timeoutMillis(environment);
      const exporter = new OTLPLogExporter({
        url: url.href,
        headers,
        timeoutMillis: exportTimeoutMillis,
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
            exportTimeoutMillis,
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
      stdout[level](stdoutEvent(event));
      otelLogger?.emit({
        eventName: event.event,
        severityNumber: level === "info" ? SeverityNumber.INFO : SeverityNumber.ERROR,
        severityText: level === "info" ? "INFO" : "ERROR",
        body: event.event,
        attributes: eventAttributes(event),
      });
    },
    shutdown() {
      shutdown ??= provider?.shutdown() ?? Promise.resolve();
      return shutdown;
    },
  };
}

export const controlLogger = createControlLogger(process.env, {
  packageVersion: process.env.npm_package_version ?? "0.1.0",
});
