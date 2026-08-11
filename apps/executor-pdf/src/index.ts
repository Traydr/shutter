import { createExecutorConfigFromEnv, serveExecutorApp } from "@shutter/executor-runtime";
import { Effect, Layer } from "effect";
import { createPdfExecutorRoutes } from "./app.js";

const routes = Layer.unwrap(
  createExecutorConfigFromEnv().pipe(Effect.map((config) => createPdfExecutorRoutes(config))),
);
serveExecutorApp(routes);
