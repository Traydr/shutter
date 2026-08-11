import { readFile } from "node:fs/promises";
import {
  type CommandRunner,
  downloadSource,
  EXECUTOR_ATTEMPT_TIMEOUT_MS,
  ProcessingFailure,
  probeWebpDimensions,
} from "@shutter/executor-runtime";
import type { SourceOriginRule } from "@shutter/protocol";
import { Effect } from "effect";

export const PDF_MAX_BYTES = 128 * 1024 * 1024;
export const ATTEMPT_TIMEOUT_MS = EXECUTOR_ATTEMPT_TIMEOUT_MS;
export { ProcessingFailure, runCommand } from "@shutter/executor-runtime";

export type { CommandRunner };

export interface PdfProcessorDependencies {
  fetch: typeof globalThis.fetch;
  runCommand: CommandRunner;
  allowedSourceOrigins: readonly SourceOriginRule[];
}

export function processPdfPreview(
  locator: string,
  inputPath: string,
  pagePrefix: string,
  outputPath: string,
  dependencies: PdfProcessorDependencies,
): Effect.Effect<{ bytes: Uint8Array; width: number; height: number }, unknown> {
  return Effect.gen(function* () {
    yield* downloadSource({
      locator,
      destination: inputPath,
      fetch: dependencies.fetch,
      allowedSourceOrigins: dependencies.allowedSourceOrigins,
      maxBytes: PDF_MAX_BYTES,
      tooLargeMessage: "PDF exceeds limit",
    });
    const info = yield* dependencies
      .runCommand("pdfinfo", [inputPath], 30_000)
      .pipe(
        Effect.catch(() =>
          Effect.fail(new ProcessingFailure("source_corrupt", "PDF metadata is invalid")),
        ),
      );
    if (/^Encrypted:\s+yes/im.test(info)) {
      return yield* Effect.fail(
        new ProcessingFailure("pdf_password_protected", "PDF is encrypted"),
      );
    }
    const pages = /^Pages:\s+(\d+)/im.exec(info)?.[1];
    if (pages === undefined || Number(pages) < 1) {
      return yield* Effect.fail(new ProcessingFailure("source_corrupt", "PDF has no pages"));
    }
    yield* Effect.gen(function* () {
      yield* dependencies.runCommand(
        "pdftoppm",
        ["-f", "1", "-singlefile", "-png", "-r", "150", inputPath, pagePrefix],
        ATTEMPT_TIMEOUT_MS,
      );
      yield* dependencies.runCommand(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          `${pagePrefix}.png`,
          "-vf",
          "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
          "-c:v",
          "libwebp",
          "-quality",
          "90",
          "-y",
          outputPath,
        ],
        ATTEMPT_TIMEOUT_MS,
      );
    }).pipe(
      Effect.catch(() =>
        Effect.fail(new ProcessingFailure("source_corrupt", "PDF page one could not be rendered")),
      ),
    );
    const bytes = yield* Effect.tryPromise(() => readFile(outputPath));
    const dimensions = yield* probeWebpDimensions(
      dependencies.runCommand,
      outputPath,
      "cover dimensions unavailable",
    );
    return { bytes, ...dimensions };
  });
}
