import { serve } from "@hono/node-server";
import { app, jobApiRuntime } from "./app.js";
import { controlLogger } from "./logging.js";
import { startRecoverySweep } from "./recovery.js";
import { createControlShutdown } from "./shutdown.js";

const portValue = process.env.PORT ?? "3000";
if (!/^[1-9]\d*$/.test(portValue)) throw new Error("PORT must be a positive integer");

const port = Number(portValue);
if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("PORT is out of range");

const server = serve({ fetch: app.fetch, port });
const stopRecovery = jobApiRuntime === undefined ? () => {} : startRecoverySweep(jobApiRuntime);
controlLogger.emit("info", { event: "control.service.started", outcome: "ready" });

const shutdown = createControlShutdown({
  logger: controlLogger,
  stopRecovery,
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    ),
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
