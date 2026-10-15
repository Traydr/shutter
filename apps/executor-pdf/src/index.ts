import { createExecutorConfigFromEnv, serveExecutor } from "@shutter/executor-runtime";
import { createPdfExecutor } from "./app.js";

serveExecutor("pdf", createPdfExecutor(createExecutorConfigFromEnv()));
