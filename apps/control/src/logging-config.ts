import type { ControlConfigShape } from "./env/server.js";

export type ControlLoggingEnvironment = Readonly<
  Pick<
    ControlConfigShape,
    | "nodeEnv"
    | "otlpLogsAllowedEndpoints"
    | "otlpLogsEndpoint"
    | "otlpLogsHeaders"
    | "otlpLogsProtocol"
    | "otlpLogsTimeout"
    | "railwayDeploymentId"
    | "railwayEnvironmentName"
    | "railwayGitCommitSha"
    | "railwayReplicaId"
    | "railwayReplicaRegion"
  >
>;

export interface OtlpLogsConfig {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  timeoutMillis: number;
}

export const OPENOBSERVE_LOG_STREAM = "default";
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

function validateOpenObserveHeaders(headers: Readonly<Record<string, string>>): void {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  if (
    normalized.size !== 2 ||
    normalized.get("stream-name") !== OPENOBSERVE_LOG_STREAM ||
    !/^Basic [A-Za-z0-9+/]+={0,2}$/u.test(normalized.get("authorization") ?? "")
  ) {
    throw new Error("incomplete OpenObserve headers");
  }
}

function timeoutMillis(environment: ControlLoggingEnvironment): number {
  const value = environment.otlpLogsTimeout;
  if (value === undefined) return MAX_OTLP_EXPORT_TIMEOUT_MILLIS;
  if (!/^[1-9]\d*$/u.test(value)) throw new Error("invalid OTLP timeout");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid OTLP timeout");
  return Math.min(parsed, MAX_OTLP_EXPORT_TIMEOUT_MILLIS);
}

function approvedEndpoints(environment: ControlLoggingEnvironment): readonly string[] {
  const value = environment.otlpLogsAllowedEndpoints;
  if (value === undefined || value.trim() === "") {
    throw new Error("missing approved OTLP endpoints");
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function readOtlpLogsConfig(
  environment: ControlLoggingEnvironment,
  allowedEndpoints: readonly string[] = approvedEndpoints(environment),
): OtlpLogsConfig | undefined {
  const configuredEndpoint = environment.otlpLogsEndpoint;
  if (configuredEndpoint === undefined) return undefined;
  if (environment.otlpLogsProtocol !== undefined && environment.otlpLogsProtocol !== "http/json") {
    throw new Error("unsupported OTLP protocol");
  }

  const endpoint = normalizedEndpoint(configuredEndpoint);
  const allowed = new Set(allowedEndpoints.map(normalizedEndpoint));
  if (!allowed.has(endpoint)) throw new Error("unapproved OTLP endpoint");

  const headers = parseHeaders(environment.otlpLogsHeaders);
  validateOpenObserveHeaders(headers);
  return { endpoint, headers, timeoutMillis: timeoutMillis(environment) };
}
