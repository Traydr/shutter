import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import type { OperationalEvent } from "@shutter/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createControlLogger, operationalErrorType } from "./logging.js";

/** The fields of one stdout line the level tests read. */
const stdoutLineSchema = z.object({ level: z.string(), event: z.string(), service: z.string() });

/** The parts of an OTLP/HTTP JSON logs request the severity test reads. */
const otlpLogsSchema = z.object({
  resourceLogs: z.array(
    z.object({
      scopeLogs: z.array(
        z.object({
          logRecords: z.array(
            z.object({
              severityNumber: z.number(),
              severityText: z.string(),
              body: z.object({ stringValue: z.string() }),
            }),
          ),
        }),
      ),
    }),
  ),
});

interface CapturedStdout {
  stdout: Writable;
  read: () => string;
}

function capturingStdout(): CapturedStdout {
  let output = "";
  return {
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    }),
    read: () => output,
  };
}

describe("ControlLogger", () => {
  it("redacts sensitive fields and never forwards credentials to unapproved OTLP endpoints", async () => {
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
    // SAFETY: listen(0, host) resolved, so the server is bound to a TCP address.
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/v1/logs`;
    const { stdout, read } = capturingStdout();
    const logger = createControlLogger(
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,stream-name=default",
      },
      { stdout },
    );

    try {
      // Junk reaches a logger through untyped merges at runtime; the allowlist must drop it.
      const leakyEvent: OperationalEvent = {
        event: "control.job.completed",
        kind: "video",
        outcome: "ready",
      };
      Object.assign(leakyEvent, {
        locator: "https://secret.example/source?token=value",
        authorization: "Bearer secret",
      });
      logger.emit("info", leakyEvent);
      await logger.shutdown();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    const output = read();
    expect(requests).toBe(0);
    expect(output).toContain("control.job.completed");
    expect(output).not.toContain("secret.example");
    expect(output).not.toContain("Bearer secret");
    expect(output).not.toContain("dXNlcjpwYXNzd29yZA");
  });

  it("labels each stdout line with the level name Railway reads", async () => {
    const { stdout, read } = capturingStdout();
    const logger = createControlLogger({}, { stdout });

    logger.emit("info", { event: "control.service.started", outcome: "ready" });
    logger.emit("error", {
      event: "control.dispatch.failed",
      kind: "pdf",
      outcome: "failed",
      failureCode: "service_unavailable",
    });
    await logger.shutdown();
    await new Promise((resolve) => setImmediate(resolve));

    const lines = read()
      .trim()
      .split("\n")
      .map((line) => stdoutLineSchema.parse(JSON.parse(line)));
    expect(lines).toEqual([
      { level: "info", event: "control.service.started", service: "shutter-control" },
      { level: "error", event: "control.dispatch.failed", service: "shutter-control" },
    ]);
  });

  it("exports gzip-compressed OTLP records with the matching severity", async () => {
    const bodies: Buffer[] = [];
    const encodings: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        encodings.push(request.headers["content-encoding"]);
        bodies.push(Buffer.concat(chunks));
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen(0, host) resolved, so the server is bound to a TCP address.
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/v1/logs`;
    const { stdout } = capturingStdout();
    const logger = createControlLogger(
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,stream-name=default",
      },
      { stdout, allowedOtlpEndpoints: [endpoint] },
    );

    try {
      logger.emit("info", { event: "control.service.started", outcome: "ready" });
      logger.emit("error", {
        event: "control.dispatch.failed",
        kind: "video",
        outcome: "failed",
        failureCode: "service_unavailable",
      });
      await logger.shutdown();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    expect(encodings).toEqual(["gzip"]);
    const [body] = bodies;
    if (body === undefined) throw new Error("expected one export");
    const exported = otlpLogsSchema.parse(JSON.parse(gunzipSync(body).toString("utf8")));
    const records = exported.resourceLogs.flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) => scope.logRecords),
    );
    expect(records).toEqual([
      { severityNumber: 9, severityText: "INFO", body: { stringValue: "control.service.started" } },
      {
        severityNumber: 17,
        severityText: "ERROR",
        body: { stringValue: "control.dispatch.failed" },
      },
    ]);
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
});
