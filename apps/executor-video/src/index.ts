import { createExecutorConfigFromEnv, serveExecutorApp } from "@shutter/executor-runtime";
import { createVideoExecutorApp } from "./app.js";

const app = createVideoExecutorApp(createExecutorConfigFromEnv());
serveExecutorApp("video", app);
