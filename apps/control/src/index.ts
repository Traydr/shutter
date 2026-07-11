import { serve } from "@hono/node-server";
import { app, jobApiRuntime } from "./app.js";
import { startRecoverySweep } from "./recovery.js";

const portValue = process.env.PORT ?? "3000";
if (!/^[1-9]\d*$/.test(portValue)) throw new Error("PORT must be a positive integer");

const port = Number(portValue);
if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("PORT is out of range");

const server = serve({ fetch: app.fetch, port });
const stopRecovery = jobApiRuntime === undefined ? () => {} : startRecoverySweep(jobApiRuntime);

function shutdown(signal: string) {
  stopRecovery();
  server.close((error) => {
    if (error) {
      console.error({ error, signal }, "failed to stop control");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
