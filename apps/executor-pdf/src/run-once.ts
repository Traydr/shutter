import { join } from "node:path";
import {
  type ExecutorConfig,
  type ExecutorProcessor,
  runExecutorOnce,
} from "@shutter/executor-runtime";
import type { Effect } from "effect";
import { ProcessingFailure, processPdfPreview, runCommand } from "./processor.js";

export type PdfExecutorConfig = ExecutorConfig;

const pdfProcessor: ExecutorProcessor = {
  kind: "pdf",
  process: (locator, directory, fetch, allowedSourceOrigins) =>
    processPdfPreview(
      locator,
      join(directory, "source.pdf"),
      join(directory, "page"),
      join(directory, "preview.webp"),
      { fetch, runCommand, allowedSourceOrigins },
    ),
  failure: (error) =>
    error instanceof ProcessingFailure
      ? { retryable: error.retryable, code: error.code }
      : { retryable: true },
};

export function runPdfOnce(
  config: PdfExecutorConfig,
): Effect.Effect<"idle" | "processed", unknown> {
  return runExecutorOnce(config, pdfProcessor);
}
