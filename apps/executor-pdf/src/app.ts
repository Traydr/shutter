import { Hono } from "hono";

export const app = new Hono();

app.get("/healthz", (context) => context.json({ ok: true, service: "executor-pdf" }));
