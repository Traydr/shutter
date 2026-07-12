import { serve } from "@hono/node-server";
import { emitOperationalEvent } from "@shutter/protocol";
import { app, jobApiRuntime } from "./app.js";
import { startRecoverySweep } from "./recovery.js";

const portValue = process.env.PORT ?? "3000";
if (!/^[1-9]\d*$/.test(portValue)) throw new Error("PORT must be a positive integer");

const port = Number(portValue);
if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("PORT is out of range");

const server = serve({ fetch: app.fetch, port });
const stopRecovery = jobApiRuntime === undefined ? () => {} : startRecoverySweep(jobApiRuntime);

function shutdown() {
  stopRecovery();
  server.close((error) => {
    if (error) {
      emitOperationalEvent("error", {
        event: "control.service.failed",
        outcome: "failed",
        failureCode: "service_unavailable",
      });
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
