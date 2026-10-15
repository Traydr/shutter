import { createExecutor, type ExecutorRunner } from "@shutter/executor-runtime";
import type { VideoExecutorConfig } from "./run-once.js";
import { runVideoOnce } from "./run-once.js";

export type VideoExecutorRunner = ExecutorRunner;

export function createVideoExecutor(
  config?: VideoExecutorConfig,
  run: VideoExecutorRunner = runVideoOnce,
) {
  return createExecutor("video", config, run);
}

export const app = createVideoExecutor().app;
