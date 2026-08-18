import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type JobFailureCode,
  type JsonValue,
  type SourceOriginRule,
  validateSourceLocator,
} from "@shutter/protocol";
import { z } from "zod";

export class ProcessingFailure extends Error {
  readonly code: JobFailureCode;
  readonly retryable: boolean;

  constructor(code: JobFailureCode, message: string, retryable = false) {
    super(message);
    this.name = "ProcessingFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
  timeoutMs: number,
) => Promise<string>;

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

export async function downloadSource(options: {
  locator: string;
  destination: string;
  fetch: typeof globalThis.fetch;
  allowedSourceOrigins: readonly SourceOriginRule[];
  maxBytes: number;
  tooLargeMessage: string;
}): Promise<void> {
  assertAllowlisted(options.locator, options.allowedSourceOrigins);
  let url = new URL(options.locator);
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    const response = await options.fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null || redirects === 2) {
        throw new ProcessingFailure("source_missing", "redirect rejected");
      }
      url = new URL(location, url);
      assertAllowlisted(url.toString(), options.allowedSourceOrigins);
      continue;
    }
    if (response.status === 404 || response.status === 410) {
      throw new ProcessingFailure("source_missing", "source missing");
    }
    if (!response.ok || response.body === null) {
      throw new ProcessingFailure("source_missing", "temporary source failure", true);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      throw new ProcessingFailure("source_too_large", options.tooLargeMessage);
    }
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        callback(
          bytes > options.maxBytes
            ? new ProcessingFailure("source_too_large", options.tooLargeMessage)
            : undefined,
          chunk,
        );
      },
    });
    // SAFETY: at runtime this body is Node's own web ReadableStream (undici);
    // only the DOM lib types it as the browser interface, which fromWeb rejects.
    const source = Readable.fromWeb(response.body as never);
    await pipeline(source, limit, createWriteStream(options.destination));
    return;
  }
}

export interface MediaDimensions {
  width: number;
  height: number;
}

/** The part of ffprobe's JSON output the executors read: the first stream's dimensions. */
const ffprobeDimensionsSchema = z.object({
  streams: z.tuple([z.object({ width: z.int(), height: z.int() })]).rest(z.unknown()),
});

export function parseFfprobeDimensions(value: string, missingMessage: string): MediaDimensions {
  let output: JsonValue;
  try {
    output = JSON.parse(value);
  } catch {
    throw new ProcessingFailure("source_corrupt", missingMessage);
  }
  const parsed = ffprobeDimensionsSchema.safeParse(output);
  if (!parsed.success) throw new ProcessingFailure("source_corrupt", missingMessage);
  const [{ width, height }] = parsed.data.streams;
  return { width, height };
}

export async function probeWebpDimensions(
  run: CommandRunner,
  path: string,
  missingMessage: string,
): Promise<MediaDimensions> {
  const probe = await run(
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
      path,
    ],
    30_000,
  );
  return parseFfprobeDimensions(probe, missingMessage);
}
