import { readFile } from "node:fs/promises";
import {
  type CommandRunner,
  downloadSource,
  ProcessingFailure,
  probeWebpDimensions,
} from "@shutter/executor-runtime";
import type { SourceOriginRule } from "@shutter/protocol";

export const PDF_MAX_BYTES = 128 * 1024 * 1024;
export const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1_000;
export { ProcessingFailure, runCommand } from "@shutter/executor-runtime";

export type { CommandRunner };

export interface PdfProcessorDependencies {
  fetch: typeof globalThis.fetch;
  runCommand: CommandRunner;
  allowedSourceOrigins: readonly SourceOriginRule[];
}

export async function processPdfPreview(
  locator: string,
  inputPath: string,
  pagePrefix: string,
  outputPath: string,
  dependencies: PdfProcessorDependencies,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  await downloadSource({
    locator,
    destination: inputPath,
    fetch: dependencies.fetch,
    allowedSourceOrigins: dependencies.allowedSourceOrigins,
    maxBytes: PDF_MAX_BYTES,
    tooLargeMessage: "PDF exceeds limit",
  });
  let info: string;
  try {
    info = await dependencies.runCommand("pdfinfo", [inputPath], 30_000);
  } catch {
    throw new ProcessingFailure("source_corrupt", "PDF metadata is invalid");
  }
  if (/^Encrypted:\s+yes/im.test(info))
    throw new ProcessingFailure("pdf_password_protected", "PDF is encrypted");
  const pages = /^Pages:\s+(\d+)/im.exec(info)?.[1];
  if (pages === undefined || Number(pages) < 1)
    throw new ProcessingFailure("source_corrupt", "PDF has no pages");
  try {
    await dependencies.runCommand(
      "pdftoppm",
      ["-f", "1", "-singlefile", "-png", "-r", "150", inputPath, pagePrefix],
      ATTEMPT_TIMEOUT_MS,
    );
    await dependencies.runCommand(
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
  } catch {
    throw new ProcessingFailure("source_corrupt", "PDF page one could not be rendered");
  }
  return {
    bytes: await readFile(outputPath),
    ...(await probeWebpDimensions(
      dependencies.runCommand,
      outputPath,
      "cover dimensions unavailable",
    )),
  };
}
