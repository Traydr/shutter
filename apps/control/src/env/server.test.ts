import { describe, expect, it } from "vitest";
import { createServerEnv } from "./server.js";

describe("Control server environment", () => {
  it("applies runtime defaults and normalizes empty optional values", () => {
    const parsed = createServerEnv({
      NODE_ENV: "",
      PORT: "",
      S3_REGION: "",
      DATABASE_URL: "",
    });

    expect(parsed).toMatchObject({
      NODE_ENV: "development",
      PORT: 3_000,
      S3_REGION: "auto",
    });
    expect(parsed.DATABASE_URL).toBeUndefined();
  });

  it("parses typed runtime values", () => {
    const parsed = createServerEnv({
      NODE_ENV: "production",
      PORT: "4310",
      DATABASE_URL: "postgresql://user:password@localhost/shutter",
      S3_ENDPOINT: "https://storage.example.com",
    });

    expect(parsed.PORT).toBe(4_310);
    expect(parsed.DATABASE_URL).toBe("postgresql://user:password@localhost/shutter");
    expect(parsed.S3_ENDPOINT).toBe("https://storage.example.com");
  });

  it("rejects invalid service configuration", () => {
    expect(() => createServerEnv({ PORT: "0" })).toThrow();
    expect(() => createServerEnv({ PORT: "not-a-port" })).toThrow();
    expect(() => createServerEnv({ DATABASE_URL: "not-a-url" })).toThrow();
  });

  it("leaves OTLP strings for the logger's non-fatal validator", () => {
    const parsed = createServerEnv({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "not-a-url",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "malformed",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "unsupported",
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "not-a-timeout",
    });

    expect(parsed).toMatchObject({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "not-a-url",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "malformed",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "unsupported",
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "not-a-timeout",
    });
  });
});
