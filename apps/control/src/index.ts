import { serve } from "@hono/node-server";
import { createControlApp } from "./app.js";
import { env } from "./env/server.js";
import { controlLogger } from "./logging.js";
import { startRecoverySweep } from "./recovery.js";
import { buildControlRuntime, featureReport } from "./runtime.js";
import { createControlShutdown } from "./shutdown.js";

const runtime = buildControlRuntime(env, {
  logger: controlLogger,
  fetch: globalThis.fetch,
  now: () => new Date(),
});
const app = createControlApp(runtime.config);

const server = serve({ fetch: app.fetch, port: env.PORT });
const stopRecovery =
  runtime.jobApiRuntime === undefined ? () => {} : startRecoverySweep(runtime.jobApiRuntime);
controlLogger.emit("info", { event: "control.service.started", outcome: "ready" });
controlLogger.emit("info", {
  event: "control.service.features",
  ...featureReport(runtime.features),
});

const shutdown = createControlShutdown({
  logger: controlLogger,
  stopRecovery,
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    ),
  closeRuntime: () => runtime.close(),
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
