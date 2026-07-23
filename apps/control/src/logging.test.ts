import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createControlLogger, operationalErrorType } from "./logging.js";

interface ReceivedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

describe("ControlLogger", () => {
  it("writes one structured stdout record when OTLP is disabled", async () => {
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createControlLogger({ NODE_ENV: "test" }, { stdout, packageVersion: "0.1.0" });

    logger.emit("info", {
      event: "control.job.completed",
      kind: "video",
      outcome: "ready",
      locator: "https://secret.example/source?token=value",
      authorization: "Bearer secret",
    } as never);
    await logger.shutdown();

    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 30,
      service: "shutter-control",
      event: "control.job.completed",
      kind: "video",
      outcome: "ready",
    });
    expect(output).not.toContain("secret.example");
    expect(output).not.toContain("Bearer secret");
  });

  it("exports the redacted event as OTLP JSON with Parseable headers", async () => {
    const received: ReceivedRequest[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/v1/logs`;
    const stdout = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const logger = createControlLogger(
      {
        NODE_ENV: "test",
        RAILWAY_ENVIRONMENT_NAME: "integration",
        RAILWAY_GIT_COMMIT_SHA: "abc123",
        RAILWAY_REPLICA_ID: "replica-1",
        RAILWAY_REPLICA_REGION: "europe-west4-drams3a",
        RAILWAY_DEPLOYMENT_ID: "deployment-1",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,X-P-Stream=shutter,X-P-Log-Source=otel-logs",
        OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "5000",
      },
      { stdout, packageVersion: "0.1.0", allowedOtlpEndpoints: [endpoint] },
    );

    try {
      logger.emit("error", {
        event: "control.http.completed",
        requestId: "request-1",
        httpMethod: "GET",
        httpRoute: "/v1/spaces/:spaceId/sources/:sourceId/previews/:kind",
        httpStatusCode: 503,
        durationMs: 42,
        outcome: "failed",
        failureCode: "service_unavailable",
      });
      await Promise.all([logger.shutdown(), logger.shutdown()]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    expect(received).toHaveLength(1);
    expect(received[0]?.headers).toMatchObject({
      authorization: "Basic dXNlcjpwYXNzd29yZA==",
      "content-type": "application/json",
      "x-p-log-source": "otel-logs",
      "x-p-stream": "shutter",
    });
    expect(received[0]?.body).toMatchObject({
      resourceLogs: [
        {
          resource: {
            attributes: expect.arrayContaining([
              { key: "service.name", value: { stringValue: "shutter-control" } },
              { key: "service.namespace", value: { stringValue: "shutter" } },
              { key: "service.version", value: { stringValue: "abc123" } },
              { key: "service.instance.id", value: { stringValue: "replica-1" } },
              {
                key: "deployment.environment.name",
                value: { stringValue: "integration" },
              },
            ]),
          },
          scopeLogs: [
            {
              logRecords: [
                expect.objectContaining({
                  severityNumber: 17,
                  severityText: "ERROR",
                  body: { stringValue: "control.http.completed" },
                  attributes: expect.arrayContaining([
                    { key: "event.name", value: { stringValue: "control.http.completed" } },
                    { key: "request.id", value: { stringValue: "request-1" } },
                    { key: "http.request.method", value: { stringValue: "GET" } },
                    { key: "http.response.status_code", value: { intValue: 503 } },
                    { key: "shutter.duration_ms", value: { intValue: 42 } },
                    {
                      key: "shutter.failure.code",
                      value: { stringValue: "service_unavailable" },
                    },
                  ]),
                }),
              ],
            },
          ],
        },
      ],
    });
  });

  it("falls back to stdout once when Parseable configuration is invalid", async () => {
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createControlLogger(
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://parseable.traydr.dev/v1/logs",
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=secret-value",
      },
      { stdout },
    );

    logger.emit("info", { event: "control.service.started", outcome: "ready" });
    await logger.shutdown();

    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      level: 50,
      event: "control.telemetry.configuration_failed",
      errorType: "ConfigurationError",
    });
    expect(records[1]).toMatchObject({ event: "control.service.started" });
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("parseable.traydr.dev");
  });

  it("refuses to send Parseable credentials to an unapproved endpoint", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/v1/logs`;
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createControlLogger(
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,X-P-Stream=shutter,X-P-Log-Source=otel-logs",
      },
      { stdout },
    );

    try {
      logger.emit("info", { event: "control.service.started", outcome: "ready" });
      await logger.shutdown();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    expect(requests).toBe(0);
    expect(output).toContain("control.telemetry.configuration_failed");
    expect(output).not.toContain("dXNlcjpwYXNzd29yZA");
  });

  it("refuses a trailing-dot alias of the approved Parseable hostname", async () => {
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createControlLogger(
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://parseable.traydr.dev./v1/logs",
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,X-P-Stream=shutter,X-P-Log-Source=otel-logs",
      },
      { stdout },
    );

    await logger.shutdown();

    expect(output).toContain("control.telemetry.configuration_failed");
    expect(output).not.toContain("parseable.traydr.dev.");
  });

  it("normalizes thrown values without retaining messages or unsafe names", () => {
    const safe = new Error("do-not-log-this-message");
    safe.name = "DatabaseError";
    const unsafe = new Error("another-secret-message");
    unsafe.name = "Unsafe name: another-secret-message";

    expect(operationalErrorType(safe)).toBe("DatabaseError");
    expect(operationalErrorType(unsafe)).toBe("Error");
    expect(operationalErrorType("do-not-log-this-string")).toBe("NonErrorThrown");
  });

  it("reports repeated exporter rejection to stdout without recursion or secret details", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("remote-secret-response");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/v1/logs`;
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createControlLogger(
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,X-P-Stream=shutter,X-P-Log-Source=otel-logs",
        OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "100",
      },
      {
        stdout,
        now: () => 0,
        batchDelayMillis: 10,
        allowedOtlpEndpoints: [endpoint],
      },
    );

    try {
      logger.emit("info", { event: "control.service.started", outcome: "ready" });
      await new Promise((resolve) => setTimeout(resolve, 25));
      logger.emit("info", { event: "control.service.stopping", outcome: "accepted" });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await logger.shutdown();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    expect(requests).toBe(2);
    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      records.filter((record) => record.event === "control.telemetry.export_failed"),
    ).toHaveLength(1);
    expect(output).not.toContain("remote-secret-response");
  });
});
