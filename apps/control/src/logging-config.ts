import type { ServerEnv } from "./env/server.js";

type ControlLoggingEnvironmentKey =
  | "NODE_ENV"
  | "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
  | "OTEL_EXPORTER_OTLP_LOGS_HEADERS"
  | "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL"
  | "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT"
  | "RAILWAY_DEPLOYMENT_ID"
  | "RAILWAY_ENVIRONMENT_NAME"
  | "RAILWAY_GIT_COMMIT_SHA"
  | "RAILWAY_REPLICA_ID"
  | "RAILWAY_REPLICA_REGION";

export type ControlLoggingEnvironment = Readonly<
  Partial<Pick<ServerEnv, ControlLoggingEnvironmentKey>>
>;

export interface OtlpLogsConfig {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  timeoutMillis: number;
}

export const PARSEABLE_OTLP_LOGS_ENDPOINT = "https://parseable.traydr.dev/v1/logs";
export const PARSEABLE_LOGS_DATASET = "shutter-logs";
const MAX_OTLP_EXPORT_TIMEOUT_MILLIS = 5_000;

function parseHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim() === "") throw new Error("missing OTLP headers");
  const headers: Record<string, string> = {};
  const normalizedNames = new Set<string>();
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("invalid OTLP headers");
    const name = decodeURIComponent(entry.slice(0, separator).trim());
    const headerValue = decodeURIComponent(entry.slice(separator + 1).trim());
    const normalizedName = name.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
      /[\r\n]/u.test(headerValue) ||
      normalizedNames.has(normalizedName)
    ) {
      throw new Error("invalid OTLP headers");
    }
    normalizedNames.add(normalizedName);
    headers[name] = headerValue;
  }
  return headers;
}

function normalizedEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("invalid OTLP endpoint");
  }
  return endpoint.href;
}

function validateParseableHeaders(headers: Readonly<Record<string, string>>): void {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  if (
    normalized.size !== 3 ||
    normalized.get("x-p-stream") !== PARSEABLE_LOGS_DATASET ||
    normalized.get("x-p-log-source") !== "otel-logs" ||
    !/^Basic [A-Za-z0-9+/]+={0,2}$/u.test(normalized.get("authorization") ?? "")
  ) {
    throw new Error("incomplete Parseable headers");
  }
}

function timeoutMillis(environment: ControlLoggingEnvironment): number {
  const value = environment.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT;
  if (value === undefined) return MAX_OTLP_EXPORT_TIMEOUT_MILLIS;
  if (!/^[1-9]\d*$/u.test(value)) throw new Error("invalid OTLP timeout");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid OTLP timeout");
  return Math.min(parsed, MAX_OTLP_EXPORT_TIMEOUT_MILLIS);
}

export function readOtlpLogsConfig(
  environment: ControlLoggingEnvironment,
  allowedEndpoints: readonly string[] = [PARSEABLE_OTLP_LOGS_ENDPOINT],
): OtlpLogsConfig | undefined {
  const configuredEndpoint = environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (configuredEndpoint === undefined) return undefined;
  if (
    environment.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL !== undefined &&
    environment.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL !== "http/json"
  ) {
    throw new Error("unsupported OTLP protocol");
  }

  const endpoint = normalizedEndpoint(configuredEndpoint);
  const allowed = new Set(allowedEndpoints.map(normalizedEndpoint));
  if (!allowed.has(endpoint)) throw new Error("unapproved OTLP endpoint");

  const headers = parseHeaders(environment.OTEL_EXPORTER_OTLP_LOGS_HEADERS);
  validateParseableHeaders(headers);
  return { endpoint, headers, timeoutMillis: timeoutMillis(environment) };
}
