import { createExecutorApp, type ExecutorRunner } from "@shutter/executor-runtime";
import type { PdfExecutorConfig } from "./run-once.js";
import { runPdfOnce } from "./run-once.js";

export type PdfExecutorRunner = ExecutorRunner;

export function createPdfExecutorApp(
  config?: PdfExecutorConfig,
  run: PdfExecutorRunner = runPdfOnce,
) {
  return createExecutorApp("pdf", config, run);
}

export const app = createPdfExecutorApp();
