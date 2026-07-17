import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type SourceOriginRule, validateSourceLocator } from "@shutter/protocol";

export const VIDEO_MAX_BYTES = 512 * 1024 * 1024;
export const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1_000;

export class ProcessingFailure extends Error {
  readonly code: "source_missing" | "source_too_large" | "source_corrupt" | "unsupported_media";
  readonly retryable: boolean;

  constructor(code: ProcessingFailure["code"], message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
  timeoutMs: number,
) => Promise<string>;

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

export async function runCommand(
  command: string,
  arguments_: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...arguments_], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

function assertAllowlisted(locator: string, rules: readonly SourceOriginRule[]): void {
  try {
    validateSourceLocator(locator, rules);
  } catch {
    throw new ProcessingFailure("source_missing", "source locator is not allowlisted");
  }
}

async function download(
  locator: string,
  destination: string,
  fetch_: typeof fetch,
  allowedSourceOrigins: readonly SourceOriginRule[],
): Promise<void> {
  assertAllowlisted(locator, allowedSourceOrigins);
  let url = new URL(locator);
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    const response = await fetch_(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null || redirects === 2)
        throw new ProcessingFailure("source_missing", "redirect rejected");
      url = new URL(location, url);
      assertAllowlisted(url.toString(), allowedSourceOrigins);
      continue;
    }
    if (response.status === 404 || response.status === 410)
      throw new ProcessingFailure("source_missing", "source missing");
    if (!response.ok || response.body === null)
      throw new ProcessingFailure("source_missing", "temporary source failure", true);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > VIDEO_MAX_BYTES)
      throw new ProcessingFailure("source_too_large", "video exceeds limit");
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        callback(
          bytes > VIDEO_MAX_BYTES
            ? new ProcessingFailure("source_too_large", "video exceeds limit")
            : undefined,
          chunk,
        );
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), limit, createWriteStream(destination));
    return;
  }
}

function dimensions(value: string): { width: number; height: number } {
  const parsed = JSON.parse(value) as { streams?: Array<{ width?: number; height?: number }> };
  const stream = parsed.streams?.[0];
  const width = stream?.width;
  const height = stream?.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new ProcessingFailure("source_corrupt", "preview dimensions are unavailable");
  }
  return { width: width as number, height: height as number };
}

export async function processVideoPreview(
  locator: string,
  inputPath: string,
  outputPath: string,
  dependencies: VideoProcessorDependencies,
): Promise<ProcessedVideoPreview> {
  await download(locator, inputPath, dependencies.fetch, dependencies.allowedSourceOrigins);
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
  const probe = await dependencies.runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      outputPath,
    ],
    30_000,
  );
  return { bytes: await readFile(outputPath), ...dimensions(probe) };
}
