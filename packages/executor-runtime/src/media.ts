import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import {
  type JobFailureCode,
  type SourceOriginRule,
  validateSourceLocator,
} from "@shutter/protocol";
import { Data, Effect, Layer, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

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

class CommandFailure extends Data.TaggedError("CommandFailure")<{
  readonly reason: "exit";
}> {}

class SourceTransferFailure extends Data.TaggedError("SourceTransferFailure")<{
  readonly cause: unknown;
}> {}

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
  timeoutMs: number,
) => Effect.Effect<string, unknown>;

const NodeChildProcessLive = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

export function runCommand(
  command: string,
  arguments_: readonly string[],
  timeoutMs: number,
): Effect.Effect<string, unknown> {
  const run = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(command, arguments_, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGKILL",
      });
      const [stdout, , exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.runDrain(handle.stderr),
          handle.exitCode,
        ] as const,
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(new CommandFailure({ reason: "exit" }));
      }
      return stdout;
    }),
  ).pipe(Effect.timeout(timeoutMs));

  return run.pipe(Effect.provide(NodeChildProcessLive));
}

function processingStep<A>(thunk: () => A): Effect.Effect<A, ProcessingFailure> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(thunk());
    } catch (error) {
      return error instanceof ProcessingFailure ? Effect.fail(error) : Effect.die(error);
    }
  });
}

function assertAllowlisted(
  locator: string,
  rules: readonly SourceOriginRule[],
): Effect.Effect<void, ProcessingFailure> {
  return validateSourceLocator(locator, rules).pipe(
    Effect.mapError(
      () => new ProcessingFailure("source_missing", "source locator is not allowlisted"),
    ),
  );
}

function fetchSource(
  fetch: typeof globalThis.fetch,
  url: URL,
): Effect.Effect<Response, SourceTransferFailure> {
  return Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      }),
    catch: (cause) => new SourceTransferFailure({ cause }),
  });
}

function writeResponse(options: {
  response: Response;
  destination: string;
  maxBytes: number;
  tooLargeMessage: string;
}): Effect.Effect<void, ProcessingFailure | SourceTransferFailure> {
  return Effect.tryPromise({
    try: (signal) => {
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
      return pipeline(
        Readable.fromWeb(options.response.body as never),
        limit,
        createWriteStream(options.destination),
        { signal },
      );
    },
    catch: (cause) =>
      cause instanceof ProcessingFailure ? cause : new SourceTransferFailure({ cause }),
  });
}

export function downloadSource(options: {
  locator: string;
  destination: string;
  fetch: typeof globalThis.fetch;
  allowedSourceOrigins: readonly SourceOriginRule[];
  maxBytes: number;
  tooLargeMessage: string;
}): Effect.Effect<void, ProcessingFailure | SourceTransferFailure> {
  return Effect.gen(function* () {
    yield* assertAllowlisted(options.locator, options.allowedSourceOrigins);
    const initialUrl = yield* Effect.sync(() => new URL(options.locator));

    const download = (
      url: URL,
      redirects: number,
    ): Effect.Effect<void, ProcessingFailure | SourceTransferFailure> =>
      Effect.gen(function* () {
        const response = yield* fetchSource(options.fetch, url);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null || redirects === 2) {
            return yield* Effect.fail(new ProcessingFailure("source_missing", "redirect rejected"));
          }
          const redirect = yield* Effect.try({
            try: () => new URL(location, url),
            catch: (cause) => new SourceTransferFailure({ cause }),
          });
          yield* assertAllowlisted(redirect.toString(), options.allowedSourceOrigins);
          return yield* download(redirect, redirects + 1);
        }
        if (response.status === 404 || response.status === 410) {
          return yield* Effect.fail(new ProcessingFailure("source_missing", "source missing"));
        }
        if (!response.ok || response.body === null) {
          return yield* Effect.fail(
            new ProcessingFailure("source_missing", "temporary source failure", true),
          );
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          return yield* Effect.fail(
            new ProcessingFailure("source_too_large", options.tooLargeMessage),
          );
        }
        yield* writeResponse({
          response,
          destination: options.destination,
          maxBytes: options.maxBytes,
          tooLargeMessage: options.tooLargeMessage,
        });
      });

    yield* download(initialUrl, 0);
  });
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

export function probeWebpDimensions(
  run: CommandRunner,
  path: string,
  missingMessage: string,
): Effect.Effect<{ width: number; height: number }, unknown> {
  return run(
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
  ).pipe(
    Effect.flatMap((probe) => processingStep(() => parseFfprobeDimensions(probe, missingMessage))),
  );
}
