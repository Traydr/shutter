import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type JobFailureCode,
  type SourceOriginRule,
  validateSourceLocator,
} from "@shutter/protocol";
import { Effect } from "effect";

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
    // TODO(effect-phase-3): Remove this adapter when media processing runs Effect natively.
    Effect.runSync(validateSourceLocator(locator, rules));
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
    await pipeline(
      Readable.fromWeb(response.body as never),
      limit,
      createWriteStream(options.destination),
    );
    return;
  }
}

export function parseFfprobeDimensions(
  value: string,
  missingMessage: string,
): { width: number; height: number } {
  const parsed = JSON.parse(value) as { streams?: Array<{ width?: number; height?: number }> };
  const stream = parsed.streams?.[0];
  const width = stream?.width;
  const height = stream?.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new ProcessingFailure("source_corrupt", missingMessage);
  }
  return { width: width as number, height: height as number };
}

export async function probeWebpDimensions(
  run: CommandRunner,
  path: string,
  missingMessage: string,
): Promise<{ width: number; height: number }> {
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
