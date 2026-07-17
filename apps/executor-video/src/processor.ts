import { readFile } from "node:fs/promises";
import {
  type CommandRunner,
  downloadSource,
  ProcessingFailure,
  probeWebpDimensions,
} from "@shutter/executor-runtime";
import type { SourceOriginRule } from "@shutter/protocol";

export const VIDEO_MAX_BYTES = 512 * 1024 * 1024;
export const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1_000;
export { ProcessingFailure, runCommand } from "@shutter/executor-runtime";

export type { CommandRunner };

export interface VideoProcessorDependencies {
  fetch: typeof globalThis.fetch;
  runCommand: CommandRunner;
  allowedSourceOrigins: readonly SourceOriginRule[];
}

export interface ProcessedVideoPreview {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export async function processVideoPreview(
  locator: string,
  inputPath: string,
  outputPath: string,
  dependencies: VideoProcessorDependencies,
): Promise<ProcessedVideoPreview> {
  await downloadSource({
    locator,
    destination: inputPath,
    fetch: dependencies.fetch,
    allowedSourceOrigins: dependencies.allowedSourceOrigins,
    maxBytes: VIDEO_MAX_BYTES,
    tooLargeMessage: "video exceeds limit",
  });
  const common = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
    "-c:v",
    "libwebp",
    "-quality",
    "90",
    "-y",
    outputPath,
  ];
  try {
    await dependencies.runCommand("ffmpeg", ["-ss", "1", ...common], ATTEMPT_TIMEOUT_MS);
  } catch {
    try {
      await dependencies.runCommand("ffmpeg", common, ATTEMPT_TIMEOUT_MS);
    } catch {
      throw new ProcessingFailure("source_corrupt", "video has no decodable frame");
    }
  }
  return {
    bytes: await readFile(outputPath),
    ...(await probeWebpDimensions(
      dependencies.runCommand,
      outputPath,
      "preview dimensions are unavailable",
    )),
  };
}
