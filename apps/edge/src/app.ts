import { Hono } from "hono";

export const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/healthz", (context) => context.json({ ok: true, service: "edge" }));
