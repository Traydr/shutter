import { createExecutor, type ExecutorRunner } from "@shutter/executor-runtime";
import type { PdfExecutorConfig } from "./run-once.js";
import { runPdfOnce } from "./run-once.js";

export type PdfExecutorRunner = ExecutorRunner;

export function createPdfExecutor(config?: PdfExecutorConfig, run: PdfExecutorRunner = runPdfOnce) {
  return createExecutor("pdf", config, run);
}

export const app = createPdfExecutor().app;
