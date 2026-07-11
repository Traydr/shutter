import { Hono } from "hono";
import type { VideoExecutorConfig } from "./run-once.js";
import { runVideoOnce } from "./run-once.js";

export type VideoExecutorRunner = (config: VideoExecutorConfig) => Promise<"idle" | "processed">;

export function createVideoExecutorApp(
  config?: VideoExecutorConfig,
  run: VideoExecutorRunner = runVideoOnce,
): Hono {
  const app = new Hono();
  let running = false;
  app.get("/healthz", (context) => context.json({ ok: true, service: "executor-video" }));
  app.post("/internal/v1/run-once", async (context) => {
    if (
      config === undefined ||
      context.req.header("authorization") !== `Bearer ${config.roleToken}`
    ) {
      return context.json({ error: { code: "unauthorized" } }, 401);
    }
    if (running) return context.json({ result: "busy" }, 202);
    running = true;
    try {
      return context.json({ result: await run(config) });
    } catch (error) {
      console.error(
        { error: error instanceof Error ? error.message : "unknown" },
        "video executor invocation failed",
      );
      return context.json({ error: { code: "execution_failed" } }, 500);
    } finally {
      running = false;
    }
  });
  return app;
}

export const app = createVideoExecutorApp();
