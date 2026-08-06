import {
  createExecutorApp,
  createExecutorRoutes,
  type ExecutorRunner,
} from "@shutter/executor-runtime";
import type { VideoExecutorConfig } from "./run-once.js";
import { runVideoOnce } from "./run-once.js";

export type VideoExecutorRunner = ExecutorRunner;

export function createVideoExecutorRoutes(
  config?: VideoExecutorConfig,
  run: VideoExecutorRunner = runVideoOnce,
) {
  return createExecutorRoutes("video", config, run);
}

export function createVideoExecutorApp(
  config?: VideoExecutorConfig,
  run: VideoExecutorRunner = runVideoOnce,
) {
  return createExecutorApp("video", config, run);
}

export const app = createVideoExecutorApp();
