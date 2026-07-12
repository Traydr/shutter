import { join } from "node:path";
import {
  type ExecutorConfig,
  type ExecutorProcessor,
  runExecutorOnce,
} from "@shutter/executor-runtime";
import { ProcessingFailure, processPdfPreview, runCommand } from "./processor.js";

export type PdfExecutorConfig = ExecutorConfig;

const pdfProcessor: ExecutorProcessor = {
  kind: "pdf",
  process: (locator, directory, fetch) =>
    processPdfPreview(
      locator,
      join(directory, "source.pdf"),
      join(directory, "page"),
      join(directory, "preview.webp"),
      { fetch, runCommand },
    ),
  failure: (error) =>
    error instanceof ProcessingFailure
      ? { retryable: error.retryable, code: error.code }
      : { retryable: true },
};

export function runPdfOnce(config: PdfExecutorConfig): Promise<"idle" | "processed"> {
  return runExecutorOnce(config, pdfProcessor);
}
