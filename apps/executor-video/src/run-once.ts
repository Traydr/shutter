import { join } from "node:path";
import {
  type ExecutorConfig,
  type ExecutorProcessor,
  runExecutorOnce,
} from "@shutter/executor-runtime";
import { ProcessingFailure, processVideoPreview, runCommand } from "./processor.js";

export type VideoExecutorConfig = ExecutorConfig;

const videoProcessor: ExecutorProcessor = {
  kind: "video",
  process: (locator, directory, fetch) =>
    processVideoPreview(locator, join(directory, "source"), join(directory, "preview.webp"), {
      fetch,
      runCommand,
    }),
  failure: (error) =>
    error instanceof ProcessingFailure
      ? { retryable: error.retryable, code: error.code }
      : { retryable: true },
};

export function runVideoOnce(config: VideoExecutorConfig): Promise<"idle" | "processed"> {
  return runExecutorOnce(config, videoProcessor);
}
