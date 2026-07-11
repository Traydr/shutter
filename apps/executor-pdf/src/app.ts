import { Hono } from "hono";
import type { PdfExecutorConfig } from "./run-once.js";
import { runPdfOnce } from "./run-once.js";

export type PdfExecutorRunner = (config: PdfExecutorConfig) => Promise<"idle" | "processed">;

export function createPdfExecutorApp(
  config?: PdfExecutorConfig,
  run: PdfExecutorRunner = runPdfOnce,
): Hono {
  const app = new Hono();
  let running = false;
  app.get("/healthz", (context) => context.json({ ok: true, service: "executor-pdf" }));
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
        "PDF executor invocation failed",
      );
      return context.json({ error: { code: "execution_failed" } }, 500);
    } finally {
      running = false;
    }
  });
  return app;
}

export const app = createPdfExecutorApp();
