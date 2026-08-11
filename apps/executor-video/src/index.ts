import { createExecutorConfigFromEnv, serveExecutorApp } from "@shutter/executor-runtime";
import { Effect, Layer } from "effect";
import { createVideoExecutorRoutes } from "./app.js";

const routes = Layer.unwrap(
  createExecutorConfigFromEnv().pipe(Effect.map((config) => createVideoExecutorRoutes(config))),
);
serveExecutorApp(routes);
