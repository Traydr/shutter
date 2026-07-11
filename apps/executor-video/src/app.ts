import { Hono } from "hono";
import type { VideoExecutorConfig } from "./run-once.js";
import { runVideoOnce } from "./run-once.js";

export function createVideoExecutorApp(
  config?: VideoExecutorConfig & { triggerToken?: string },
): Hono {
  const app = new Hono();
  app.get("/healthz", (context) => context.json({ ok: true, service: "executor-video" }));
  app.post("/internal/v1/run-once", async (context) => {
    if (
      config?.triggerToken === undefined ||
      context.req.header("authorization") !== `Bearer ${config.triggerToken}`
    ) {
      return context.json({ error: { code: "unauthorized" } }, 401);
    }
    return context.json({ result: await runVideoOnce(config) });
  });
  return app;
}

export const app = createVideoExecutorApp();
