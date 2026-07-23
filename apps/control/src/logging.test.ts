import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createControlLogger, operationalErrorType } from "./logging.js";

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
    const logger = createControlLogger(
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS:
          "Authorization=Basic%20dXNlcjpwYXNzd29yZA%3D%3D,stream-name=default",
      },
      { stdout },
    );

    try {
      logger.emit("info", {
        event: "control.job.completed",
        kind: "video",
        outcome: "ready",
        locator: "https://secret.example/source?token=value",
        authorization: "Bearer secret",
      } as never);
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
