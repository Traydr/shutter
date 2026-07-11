import { Hono } from "hono";
import type { PdfExecutorConfig } from "./run-once.js";
import { runPdfOnce } from "./run-once.js";

export function createPdfExecutorApp(config?: PdfExecutorConfig & { triggerToken: string }): Hono {
  const app = new Hono();
  app.get("/healthz", (context) => context.json({ ok: true, service: "executor-pdf" }));
  app.post("/internal/v1/run-once", async (context) => {
    if (
      config === undefined ||
      context.req.header("authorization") !== `Bearer ${config.triggerToken}`
    ) {
      return context.json({ error: { code: "unauthorized" } }, 401);
    }
    return context.json({ result: await runPdfOnce(config) });
  });
  return app;
}

export const app = createPdfExecutorApp();
