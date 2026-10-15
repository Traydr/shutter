import { join } from "node:path";
import {
  type ExecutorConfig,
  type ExecutorProcessor,
  runExecutorOnce,
} from "@shutter/executor-runtime";
import type { ExecutorInvocationResult } from "@shutter/protocol";
import { ProcessingFailure, processPdfPreview, runCommand } from "./processor.js";

export type PdfExecutorConfig = ExecutorConfig;

const pdfProcessor: ExecutorProcessor = {
  kind: "pdf",
  process: ({ locator, directory, fetch, allowedSourceOrigins, signal }) =>
    processPdfPreview(
      locator,
      join(directory, "source.pdf"),
      join(directory, "page"),
      join(directory, "preview.webp"),
      { fetch, runCommand, allowedSourceOrigins, signal },
    ),
  failure: (error) =>
    error instanceof ProcessingFailure
      ? { retryable: error.retryable, code: error.code }
      : { retryable: true },
};

export function runPdfOnce(config: PdfExecutorConfig): Promise<ExecutorInvocationResult> {
  return runExecutorOnce(config, pdfProcessor);
}
