import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import { OtlpExporter } from "effect/unstable/observability";
import { describe, expect, it } from "vitest";
import { createControlRoutes } from "./app.js";
import { loadControlConfig } from "./env/server.js";
import { ControlLogger, makeControlLoggingLayer, operationalErrorType } from "./logging.js";
import type { RenditionJobLifecycleShape } from "./rendition-job-lifecycle.js";

function capturingStdout(): { stdout: Writable; read: () => string } {
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
  it("exports allowlisted events without leaking request or library telemetry", async () => {
    const captured: Record<"logs" | "traces", unknown[]> = { logs: [], traces: [] };
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const signal = request.url === "/v1/logs" ? "logs" : "traces";
        captured[signal].push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const { port } = receiver.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/v1/logs`;
    const sourceId = "source-id-must-never-export";
    const source =
      "https://t3.storageapi.dev/balanced-wrap-ocyiwwexhao/originals/private.jpg?X-Amz-Signature=locator-must-never-export";
    const authorization = "Bearer header-value-must-never-export";
    const capability = "capability-must-never-export";
    const sql = "select 'sql-text-must-never-export'";
    const errorMessage = "raw-error-message-must-never-export";
    const requestBody = `body-must-never-export-${capability}`;
    const forbidden = [
      `/v1/spaces/pane-view/sources/${sourceId}/previews/video`,
      source,
      "X-Amz-Signature",
      "locator-must-never-export",
      authorization,
      "header-value-must-never-export",
      capability,
      sourceId,
      sql,
      "db.query.text",
      "url.full",
      "url.path",
      "url.query",
      "user_agent.original",
      "http.request.header.",
      "client.address",
      requestBody,
      errorMessage,
    ];
    const token = "s".repeat(32);
    const lifecycle = {
      read: () =>
        Effect.useSpan(`job ${sourceId}`, {}, () =>
          Effect.useSpan("sql.execute", { kind: "client" }, (span) => {
            span.attribute("db.query.text", sql);
            return Effect.die(new Error(errorMessage));
          }),
        ),
      submit: () => Effect.die("unused"),
      claim: () => Effect.die("unused"),
      heartbeat: () => Effect.die("unused"),
      complete: () => Effect.die("unused"),
      fail: () => Effect.die("unused"),
      maintain: () => Effect.die("unused"),
      withInvalidatedSource: () => Effect.die("unused"),
    } as unknown as RenditionJobLifecycleShape;
    const config = await Effect.runPromise(
      loadControlConfig({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,stream-name=default",
      }),
    );
    const logging = makeControlLoggingLayer(config, {
      allowedOtlpEndpoints: [endpoint],
      stdout: capturingStdout().stdout,
    });
    const routes = Layer.unwrap(
      Effect.map(ControlLogger, (logger) =>
        createControlRoutes({
          logger,
          originAuthToken: () => undefined,
          imgproxy: { buildRequest: () => Effect.die("unused") },
          fetch: globalThis.fetch,
          masterStore: { presignGet: () => Effect.die("unused") },
          jobApiRuntime: {
            logger,
            lifecycle,
            now: () => new Date("2026-08-06T00:00:00Z"),
            spaceApiTokens: () => new Map([["pane-view", [token]]]),
            capabilityKeys: () => new Map(),
            executorToken: () => undefined,
            dispatch: () => Effect.void,
          },
        }),
      ),
    );

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* HttpRouter.serve(routes, { disableLogger: true }).pipe(Layer.build);
          yield* HttpClient.get(
            `/internal/v1/spike/rendition?key=private&source=${encodeURIComponent(source)}&w=640&q=75`,
            {
              headers: {
                authorization,
                "user-agent": "header-value-must-never-export",
              },
            },
          );
          const jobUrl = `/v1/spaces/pane-view/sources/${sourceId}/previews/video`;
          yield* HttpClient.put(jobUrl, {
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: HttpBody.text(requestBody),
          });
          yield* HttpClient.get(jobUrl, { headers: { authorization: `Bearer ${token}` } });
          yield* Effect.log(`library.raw ${errorMessage}`);
          yield* Effect.sleep("1100 millis");
          const flusher = yield* OtlpExporter.Flusher;
          yield* flusher.flush;
        }).pipe(Effect.scoped, Effect.provide([NodeHttpServer.layerTest, logging])),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    expect(captured.logs.length).toBeGreaterThan(0);
    expect(captured.traces.length).toBeGreaterThan(0);
    const logs = JSON.stringify(captured.logs);
    const traces = JSON.stringify(captured.traces);
    expect(logs).toContain("control.http.completed");
    for (const secret of forbidden) {
      expect(logs, `logs contained ${secret}`).not.toContain(secret);
      expect(traces, `traces contained ${secret}`).not.toContain(secret);
    }
  });

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
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/v1/logs`;
    const { stdout, read } = capturingStdout();
    const config = await Effect.runPromise(
      loadControlConfig({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,stream-name=default",
      }),
    );
    const runtime = ManagedRuntime.make(makeControlLoggingLayer(config, { stdout }));
    const logger = await runtime.runPromise(ControlLogger);

    try {
      await runtime.runPromise(
        logger.emit("info", {
          event: "control.job.completed",
          kind: "video",
          outcome: "ready",
          locator: "https://secret.example/source?token=value",
          authorization: "Bearer secret",
        } as never),
      );
      await runtime.dispose();
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

  it("replaces an invalid event name at the sanitization boundary", async () => {
    const { stdout, read } = capturingStdout();
    const config = await Effect.runPromise(loadControlConfig({}));
    const runtime = ManagedRuntime.make(makeControlLoggingLayer(config, { stdout }));
    const logger = await runtime.runPromise(ControlLogger);

    await runtime.runPromise(
      logger.emit("error", {
        event: "unsanitized.event-name-must-never-export",
        outcome: "failed",
      } as never),
    );
    await runtime.dispose();

    expect(read()).toContain("control.service.failed");
    expect(read()).not.toContain("unsanitized.event-name-must-never-export");
  });

  it("applies the export deadline and rate-limits failure diagnostics", async () => {
    let requests = 0;
    const receiver = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        if (requests <= 2) {
          setTimeout(() => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{}");
          }, 100);
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const { port } = receiver.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/v1/logs`;
    const { stdout, read } = capturingStdout();
    const config = await Effect.runPromise(
      loadControlConfig({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,stream-name=default",
        OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "20",
      }),
    );
    const runtime = ManagedRuntime.make(
      makeControlLoggingLayer(config, {
        allowedOtlpEndpoints: [endpoint],
        now: () => 1_000_000,
        stdout,
      }),
    );
    const logger = await runtime.runPromise(ControlLogger);

    try {
      await runtime.runPromise(
        logger.emit("info", { event: "control.service.started", outcome: "ready" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 4_300));
      expect(requests).toBeGreaterThanOrEqual(3);
      expect(read().match(/control\.telemetry\.export_failed/gu)).toHaveLength(1);
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  }, 10_000);

  it("bounds the pending OTLP log queue", async () => {
    const payloads: unknown[] = [];
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url === "/v1/logs") {
          payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const { port } = receiver.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/v1/logs`;
    const config = await Effect.runPromise(
      loadControlConfig({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,stream-name=default",
      }),
    );
    const runtime = ManagedRuntime.make(
      makeControlLoggingLayer(config, {
        allowedOtlpEndpoints: [endpoint],
        stdout: capturingStdout().stdout,
      }),
    );
    const logger = await runtime.runPromise(ControlLogger);

    try {
      await runtime.runPromise(
        Effect.forEach(
          Array.from({ length: 2_049 }),
          () => logger.emit("info", { event: "control.service.started", outcome: "ready" }),
          { discard: true },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await runtime.dispose();
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    const records = payloads.flatMap((payload) => {
      const root = payload as {
        resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: unknown[] }> }>;
      };
      return (
        root.resourceLogs?.flatMap(
          (resource) => resource.scopeLogs?.flatMap((scope) => scope.logRecords ?? []) ?? [],
        ) ?? []
      );
    });
    expect(records).toHaveLength(2_048);
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
