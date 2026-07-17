import { createExecutorConfigFromEnv, serveExecutorApp } from "@shutter/executor-runtime";
import { createPdfExecutorApp } from "./app.js";

const app = createPdfExecutorApp(createExecutorConfigFromEnv());
serveExecutorApp("pdf", app);
