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

export const VIDEO_MAX_BYTES = 512 * 1024 * 1024;
export const ATTEMPT_TIMEOUT_MS = EXECUTOR_ATTEMPT_TIMEOUT_MS;
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

export function processVideoPreview(
  locator: string,
  inputPath: string,
  outputPath: string,
  dependencies: VideoProcessorDependencies,
): Effect.Effect<ProcessedVideoPreview, unknown> {
  return Effect.gen(function* () {
    yield* downloadSource({
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
    yield* dependencies
      .runCommand("ffmpeg", ["-ss", "1", ...common], ATTEMPT_TIMEOUT_MS)
      .pipe(
        Effect.catch(() =>
          dependencies
            .runCommand("ffmpeg", common, ATTEMPT_TIMEOUT_MS)
            .pipe(
              Effect.catch(() =>
                Effect.fail(
                  new ProcessingFailure("source_corrupt", "video has no decodable frame"),
                ),
              ),
            ),
        ),
      );
    const bytes = yield* Effect.tryPromise(() => readFile(outputPath));
    const dimensions = yield* probeWebpDimensions(
      dependencies.runCommand,
      outputPath,
      "preview dimensions are unavailable",
    );
    return { bytes, ...dimensions };
  });
}
