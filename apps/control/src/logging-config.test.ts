import { describe, expect, it } from "vitest";
import { readOtlpLogsConfig } from "./logging-config.js";

const ENDPOINT = "https://openobserve.traydr.dev/api/default/v1/logs";
const HEADERS = "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,stream-name=default";

describe("Control OTLP logging configuration", () => {
  it("accepts only the default OpenObserve stream without exporter-owned headers", () => {
    expect(
      readOtlpLogsConfig({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ENDPOINT,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: HEADERS,
      })?.headers,
    ).toMatchObject({ "stream-name": "default" });

    expect(() =>
      readOtlpLogsConfig({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://openobserve.traydr.dev/api/default",
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: HEADERS,
      }),
    ).toThrow();
    expect(() =>
      readOtlpLogsConfig({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ENDPOINT,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: HEADERS.replace("default", "shutter"),
      }),
    ).toThrow();
    expect(() =>
      readOtlpLogsConfig({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ENDPOINT,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: `${HEADERS},Content-Type=application/json`,
      }),
    ).toThrow();
  });

  it("clamps a configured exporter timeout to the shutdown flush allowance", () => {
    const config = readOtlpLogsConfig({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ENDPOINT,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: HEADERS,
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "60000",
    });

    expect(config?.timeoutMillis).toBe(5_000);
  });
});
