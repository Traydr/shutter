import { serve } from "@hono/node-server";
import { app, jobApiRuntime } from "./app.js";
import { env } from "./env/server.js";
import { controlLogger } from "./logging.js";
import { startRecoverySweep } from "./recovery.js";
import { createControlShutdown } from "./shutdown.js";

const server = serve({ fetch: app.fetch, port: env.PORT });
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
