import {
  createExecutorApp,
  createExecutorRoutes,
  type ExecutorRunner,
} from "@shutter/executor-runtime";
import type { PdfExecutorConfig } from "./run-once.js";
import { runPdfOnce } from "./run-once.js";

export type PdfExecutorRunner = ExecutorRunner;

export function createPdfExecutorRoutes(
  config?: PdfExecutorConfig,
  run: PdfExecutorRunner = runPdfOnce,
) {
  return createExecutorRoutes("pdf", config, run);
}

export function createPdfExecutorApp(
  config?: PdfExecutorConfig,
  run: PdfExecutorRunner = runPdfOnce,
) {
  return createExecutorApp("pdf", config, run);
}

export const app = createPdfExecutorApp();
