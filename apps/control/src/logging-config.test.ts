import { describe, expect, it } from "vitest";
import { readOtlpLogsConfig } from "./logging-config.js";

const ENDPOINT = "https://parseable.traydr.dev/v1/logs";
const HEADERS =
  "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,X-P-Stream=shutter,X-P-Log-Source=otel-logs";

describe("Control OTLP logging configuration", () => {
  it("clamps a configured exporter timeout to the shutdown flush allowance", () => {
    const config = readOtlpLogsConfig({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ENDPOINT,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: HEADERS,
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "60000",
    });

    expect(config?.timeoutMillis).toBe(5_000);
  });
});
