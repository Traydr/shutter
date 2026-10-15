import { readFile } from "node:fs/promises";
import {
  CommandFailure,
  type CommandRunner,
  downloadSource,
  MASTER_PREVIEW_ENCODER_OPTIONS,
  MASTER_PREVIEW_SCALE_FILTER,
  openRangeSource,
  PROXY_MAX_SILENCE_MS,
  type ProcessedMasterPreview,
  ProcessingFailure,
  type ProxyOutcome,
  readWebpDimensions,
  type SourceDownload,
  type SourceProxy,
} from "@shutter/executor-runtime";
import type { SourceOriginRule } from "@shutter/protocol";

export const VIDEO_MAX_BYTES = 512 * 1024 * 1024;
export const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1_000;
export { ProcessingFailure, runCommand } from "@shutter/executor-runtime";

export type { CommandRunner };

/** The containers ffmpeg may demux; playlists, concat lists, and image sequences are not among them. */
export const VIDEO_FORMATS = "mov,matroska,avi,mpegts,flv,ogg,asf,mpeg";

/**
 * Decoder limits. Four threads keep a 4K decode near 270 MB, where automatic
 * threading takes 2–3 times the memory for no speed on four vCPUs; the pixel cap
 * (8K) rejects anything larger before a frame buffer is allocated.
 */
const DECODER_OPTIONS = ["-threads", "4", "-max_pixels", "33177600"];

/**
 * How long ffmpeg waits on a proxy read: 30 s beyond the longest the proxy can
 * keep it waiting on the origin, so a slow origin is reported by the proxy, as a
 * retryable timeout, before ffmpeg gives up on it.
 */
const PROXY_READ_TIMEOUT_MS = PROXY_MAX_SILENCE_MS + 30_000;

/** ffmpeg may speak only plain HTTP to the loopback proxy. `-rw_timeout` is in microseconds. */
const PROXY_INPUT_OPTIONS = [
  "-protocol_whitelist",
  "http,tcp",
  "-multiple_requests",
  "1",
  "-rw_timeout",
  String(PROXY_READ_TIMEOUT_MS * 1_000),
];
const FILE_INPUT_OPTIONS = ["-protocol_whitelist", "file"];

/** The one-second frame first, then the first decodable frame for anything that has none there. */
const SEEKS = [["-ss", "1"], []] as const;

export interface VideoPreviewRequest {
  locator: string;
  /** Where the source is written when it has to be downloaded whole. */
  inputPath: string;
  outputPath: string;
}

export interface VideoProcessorDependencies {
  fetch: typeof globalThis.fetch;
  runCommand: CommandRunner;
  allowedSourceOrigins: readonly SourceOriginRule[];
  /** Abandons the attempt: kills ffmpeg, stops the source proxy, and cancels source requests. */
  signal: AbortSignal;
}

/** One ffmpeg capture: what it opens, under which protocol whitelist, and where it writes. */
interface Capture {
  /** The proxy URL or the downloaded file. */
  location: string;
  inputOptions: readonly string[];
  outputPath: string;
  dependencies: VideoProcessorDependencies;
}

type StreamedFrame = { kind: "rendered"; bytes: Uint8Array } | { kind: "fallback" };

/**
 * Captures the Master Preview frame. ffmpeg reads the source through a loopback
 * Range proxy, so it fetches only the bytes it decodes. When the origin does not
 * honor ranges, stops honoring them, or yields no frame through the proxy, the
 * source is downloaded to `inputPath` and read locally: only a complete local
 * copy can show a video is corrupt.
 */
export async function processVideoPreview(
  { locator, inputPath, outputPath }: VideoPreviewRequest,
  dependencies: VideoProcessorDependencies,
): Promise<ProcessedMasterPreview> {
  const source: SourceDownload = {
    locator,
    allowedSourceOrigins: dependencies.allowedSourceOrigins,
    fetch: dependencies.fetch,
    maxBytes: VIDEO_MAX_BYTES,
    tooLargeMessage: "video exceeds limit",
    destination: inputPath,
    signal: dependencies.signal,
  };

  const opened = await openRangeSource(source);
  if (opened.kind === "proxy") {
    const streamed = await captureThroughProxy(opened.proxy, outputPath, dependencies);
    if (streamed.kind === "rendered") return preview(streamed.bytes);

    await downloadSource(source);
  }

  const local = { location: inputPath, inputOptions: FILE_INPUT_OPTIONS, outputPath, dependencies };
  for (const seek of SEEKS) {
    const bytes = await capture(local, seek);
    if (bytes !== undefined) return preview(bytes);
  }

  throw noDecodableFrame();
}

/**
 * Captures through the proxy, trusting ffmpeg's result only when the proxy saw
 * no problem. No frame without a problem still falls back: what ffmpeg read
 * through the proxy is not enough to call the video corrupt.
 */
async function captureThroughProxy(
  proxy: SourceProxy,
  outputPath: string,
  dependencies: VideoProcessorDependencies,
): Promise<StreamedFrame> {
  const streamed = {
    location: proxy.url,
    inputOptions: PROXY_INPUT_OPTIONS,
    outputPath,
    dependencies,
  };
  try {
    for (const seek of SEEKS) {
      const bytes = await capture(streamed, seek);
      await proxy.idle();
      const outcome = proxy.outcome;
      if (outcome !== undefined) return settle(outcome);
      if (bytes !== undefined) return { kind: "rendered", bytes };
    }
  } finally {
    await proxy.close();
  }

  return { kind: "fallback" };
}

function settle(outcome: ProxyOutcome): StreamedFrame {
  switch (outcome.kind) {
    case "failed":
      throw outcome.failure;
    case "fallback":
      return { kind: "fallback" };
    default: {
      const _exhaustive: never = outcome;

      return _exhaustive;
    }
  }
}

function noDecodableFrame(): ProcessingFailure {
  return new ProcessingFailure("source_corrupt", "video has no decodable frame");
}

/**
 * Runs one ffmpeg capture and returns the WebP, or nothing when ffmpeg failed or
 * wrote an empty file (a seek past the end of a short clip exits 0 with one).
 * Aborts and spawn errors propagate.
 */
async function capture(input: Capture, seek: readonly string[]): Promise<Uint8Array | undefined> {
  const arguments_ = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...seek,
    ...DECODER_OPTIONS,
    "-format_whitelist",
    VIDEO_FORMATS,
    ...input.inputOptions,
    "-i",
    input.location,
    "-frames:v",
    "1",
    "-vf",
    MASTER_PREVIEW_SCALE_FILTER,
    ...MASTER_PREVIEW_ENCODER_OPTIONS,
    "-y",
    input.outputPath,
  ];
  try {
    await input.dependencies.runCommand("ffmpeg", arguments_, {
      timeoutMs: ATTEMPT_TIMEOUT_MS,
      signal: input.dependencies.signal,
    });
  } catch (error) {
    if (error instanceof CommandFailure) return undefined;

    throw error;
  }

  const bytes = await readFile(input.outputPath);

  return bytes.byteLength > 0 ? bytes : undefined;
}

function preview(bytes: Uint8Array): ProcessedMasterPreview {
  return { bytes, ...readWebpDimensions(bytes) };
}
