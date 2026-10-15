import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { type JobFailureCode, MASTER_PREVIEW_MAX_DIMENSION } from "@shutter/protocol";
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

/** A process to run: an executable and its arguments, never a shell string. */
export interface Command {
  command: string;
  arguments: readonly string[];
}

export interface CommandOptions {
  timeoutMs: number;
  /** Abandons the attempt: kills the process (and its producer) and rejects with the abort reason. */
  signal?: AbortSignal;
  /** Feeds this command's stdin from another command's stdout; both must exit 0. */
  stdinFrom?: Command;
}

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
  options: CommandOptions,
) => Promise<string>;

/** How much of a failed command's stderr is kept: enough to classify the failure. */
export const STDERR_TAIL_BYTES = 4 * 1024;
/** The commands report on stdout in a few lines; anything larger is not a report. */
export const STDOUT_LIMIT_BYTES = 1024 * 1024;

/** How a command that did not exit 0 ended. */
export interface FailedCommand {
  command: string;
  /** `null` when the process was killed rather than exiting. */
  exitCode: number | null;
  stderrTail: string;
}

/**
 * A command that ran and did not exit 0: it failed, was killed at its timeout,
 * or overran the stdout limit. `stderrTail` exists only to classify the failure;
 * it is tool output and must never be logged or returned.
 */
export class CommandFailure extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor({ command, exitCode, stderrTail }: FailedCommand) {
    super(`${command} exited with code ${exitCode ?? "unknown"}`);
    this.name = "CommandFailure";
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

type ChildExit =
  | { kind: "exited"; code: number | null; stderrTail: string }
  | { kind: "spawn_failed"; error: Error };

interface RunningChild {
  command: string;
  child: ChildProcessWithoutNullStreams;
  exit: Promise<ChildExit>;
}

/** Keeps only the last STDERR_TAIL_BYTES of a stream, so a chatty tool never blocks on a full pipe. */
function collectTail(stream: Readable): () => string {
  let chunks: Buffer[] = [];
  let size = 0;
  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.byteLength;
    if (size > 2 * STDERR_TAIL_BYTES) {
      const tail = Buffer.concat(chunks).subarray(-STDERR_TAIL_BYTES);
      chunks = [tail];
      size = tail.byteLength;
    }
  });

  return () => Buffer.concat(chunks).subarray(-STDERR_TAIL_BYTES).toString("utf8");
}

/**
 * All a child inherits of the Executor's environment: where to find executables,
 * and a home, temporary directory, and locale for fontconfig and the like. The
 * rest holds the role token and storage credentials, which no media tool needs.
 */
const CHILD_ENVIRONMENT_VARIABLES = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENVIRONMENT_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }

  return environment;
}

function start(command: Command): RunningChild {
  const child = spawn(command.command, [...command.arguments], {
    env: childEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  // A child that exits before reading its stdin reports that through its exit code, not EPIPE.
  child.stdin.on("error", () => undefined);
  const stderr = collectTail(child.stderr);
  const exit = new Promise<ChildExit>((resolve) => {
    child.once("error", (error) => resolve({ kind: "spawn_failed", error }));
    child.once("close", (code) => resolve({ kind: "exited", code, stderrTail: stderr() }));
  });

  return { command: command.command, child, exit };
}

/**
 * Runs a command without a shell and resolves with its stdout. With `stdinFrom`,
 * the producer's stdout is piped into the command's stdin and the pair succeeds
 * only if both exit 0, so a truncated stream can never pass as output. stderr is
 * drained into a bounded tail for classification only.
 */
export async function runCommand(
  command: string,
  arguments_: readonly string[],
  options: CommandOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  const producer = options.stdinFrom === undefined ? undefined : start(options.stdinFrom);
  const consumer = start({ command, arguments: arguments_ });
  const running = producer === undefined ? [consumer] : [producer, consumer];
  const killAll = () => {
    for (const { child } of running) child.kill("SIGKILL");
  };

  if (producer === undefined) {
    consumer.child.stdin.end();
  } else {
    producer.child.stdin.end();
    producer.child.stdout.pipe(consumer.child.stdin);
  }

  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  consumer.child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > STDOUT_LIMIT_BYTES) killAll();
    else stdout.push(chunk);
  });

  const timeout = setTimeout(killAll, options.timeoutMs);
  options.signal?.addEventListener("abort", killAll, { once: true });
  let exits: { stage: RunningChild; result: ChildExit }[];
  try {
    exits = await Promise.all(
      running.map(async (stage) => {
        const result = await stage.exit;
        // A failed stage, or a consumer that stopped reading, leaves nothing worth waiting for.
        if (result.kind !== "exited" || result.code !== 0 || stage === consumer) killAll();

        return { stage, result };
      }),
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", killAll);
  }

  options.signal?.throwIfAborted();
  for (const { stage, result } of exits) {
    if (result.kind === "spawn_failed") throw result.error;
    if (result.code !== 0) {
      throw new CommandFailure({
        command: stage.command,
        exitCode: result.code,
        stderrTail: result.stderrTail,
      });
    }
  }

  if (stdoutBytes > STDOUT_LIMIT_BYTES) {
    throw new CommandFailure({ command, exitCode: null, stderrTail: "" });
  }

  return Buffer.concat(stdout).toString("utf8");
}

export interface MediaDimensions {
  width: number;
  height: number;
}

function fourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** The 24-bit little-endian field the VP8X header stores dimensions in. */
function uint24(view: DataView, offset: number): number {
  return (
    view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
  );
}

/**
 * Reads a WebP's canvas size from its RIFF header (the simple lossy `VP8 `,
 * lossless `VP8L`, and extended `VP8X` layouts) instead of spawning ffprobe.
 */
export function readWebpDimensions(bytes: Uint8Array): MediaDimensions {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 30 && fourCc(view, 0) === "RIFF" && fourCc(view, 8) === "WEBP") {
    switch (fourCc(view, 12)) {
      case "VP8 ":
        // Frame tag (3 bytes), then the 9d 01 2a start code, then 14-bit width and height.
        if (
          view.getUint8(23) === 0x9d &&
          view.getUint8(24) === 0x01 &&
          view.getUint8(25) === 0x2a
        ) {
          return {
            width: view.getUint16(26, true) & 0x3fff,
            height: view.getUint16(28, true) & 0x3fff,
          };
        }
        break;
      case "VP8L":
        // Signature 0x2f, then width-1 and height-1 as consecutive 14-bit fields.
        if (view.getUint8(20) === 0x2f) {
          const bits = view.getUint32(21, true);

          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        break;
      case "VP8X":
        return { width: uint24(view, 24) + 1, height: uint24(view, 27) + 1 };
    }
  }

  throw new ProcessingFailure("source_corrupt", "preview is not a WebP image");
}

const pdfCoordinateSchema = z.coerce.number().pipe(z.number());

/** The part of `pdfinfo -f 1 -l 1 -box` output the PDF executor reads, as page one's size in points. */
const pdfFirstPageSchema = z
  .object({
    pages: z.coerce.number().pipe(z.int().positive()),
    rotation: z.coerce
      .number()
      .pipe(z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])),
    mediaBox: z.tuple([
      pdfCoordinateSchema,
      pdfCoordinateSchema,
      pdfCoordinateSchema,
      pdfCoordinateSchema,
    ]),
  })
  .transform(({ pages, rotation, mediaBox: [left, bottom, right, top] }) => ({
    pages,
    rotation,
    width: Math.abs(right - left),
    height: Math.abs(top - bottom),
  }))
  .refine((page) => page.width > 0 && page.height > 0);

export type PdfFirstPage = z.infer<typeof pdfFirstPageSchema>;

/**
 * The last line matching `pattern`. pdfinfo prints the document's own strings
 * (Title, Author, ...) before its counts and page boxes, so the last match is
 * pdfinfo's, even when a string embeds a line that looks like one.
 */
function lastCaptures(text: string, pattern: RegExp): string[] | undefined {
  let last: string[] | undefined;
  for (const match of text.matchAll(pattern)) last = match.slice(1);

  return last;
}

/** Reads page one's MediaBox and rotation from pdfinfo output; `undefined` when they are absent or unusable. */
export function parsePdfInfo(info: string): PdfFirstPage | undefined {
  const parsed = pdfFirstPageSchema.safeParse({
    pages: lastCaptures(info, /^Pages:\s+(\S+)\s*$/gm)?.[0],
    rotation: lastCaptures(info, /^Page\s+1 rot:\s+(\S+)\s*$/gm)?.[0],
    mediaBox: lastCaptures(info, /^Page\s+1 MediaBox:\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/gm),
  });

  return parsed.success ? parsed.data : undefined;
}

/**
 * The ffmpeg filter that fits a Master Preview in a square box: the longest edge
 * is at most MASTER_PREVIEW_MAX_DIMENSION, the aspect ratio is kept, and a
 * smaller frame is never enlarged.
 */
export const MASTER_PREVIEW_SCALE_FILTER = `scale='min(${MASTER_PREVIEW_MAX_DIMENSION},iw)':'min(${MASTER_PREVIEW_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`;

/** ffmpeg output options for every Master Preview: quality-90 WebP at libwebp's compression level 4. */
export const MASTER_PREVIEW_ENCODER_OPTIONS = [
  "-c:v",
  "libwebp",
  "-quality",
  "90",
  "-compression_level",
  "4",
] as const;
