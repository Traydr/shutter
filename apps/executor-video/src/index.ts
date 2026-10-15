import { createExecutorConfigFromEnv, serveExecutor } from "@shutter/executor-runtime";
import { createVideoExecutor } from "./app.js";

serveExecutor("video", createVideoExecutor(createExecutorConfigFromEnv()));
