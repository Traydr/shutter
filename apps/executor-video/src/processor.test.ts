import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandFailure, type CommandOptions } from "@shutter/executor-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  type ProcessingFailure,
  processVideoPreview,
  VIDEO_MAX_BYTES,
} from "./processor.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function paths(): Promise<{ input: string; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), "shutter-video-test-"));
  directories.push(directory);

  return { input: join(directory, "source"), output: join(directory, "preview.webp") };
}

const LOCATOR = "https://media.example/video.mp4";
const RULES = [{ origin: "https://media.example" }];
/** A real 3x5 libwebp frame (`-c:v libwebp -quality 90`). */
const FRAME = Buffer.from(
  "UklGRkAAAABXRUJQVlA4IDQAAAAwAgCdASoDAAUAAMASJaACdLoB+AH4AARoAAD++kXL/3easNN39a3/9aOfron+tHP/WVgA",
  "base64",
);
const SOURCE = randomBytes(1024 * 1024);
/** An attempt that is never abandoned. */
const ATTEMPT = new AbortController().signal;

/**
 * What the origin is asked for, and how it answers: honoring ranges unless told
 * otherwise, or never answering until the request is aborted.
 */
type OriginAnswer =
  | "range"
  | "whole"
  | "hang"
  | { status: number; headers?: Record<string, string> };

function origin(answer: (range: string | null, index: number) => OriginAnswer = () => "range") {
  const ranges: (string | null)[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    const range = new Headers(init?.headers).get("range");
    ranges.push(range);
    const planned = answer(range, ranges.length - 1);
    if (planned === "whole") return new Response(SOURCE, { status: 200 });
    if (planned === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }

    if (planned !== "range") return new Response(null, planned);

    const [, first = "0", last = ""] = /^bytes=(\d+)-(\d*)$/.exec(range ?? "") ?? [];
    const start = Number(first);
    const end = last === "" ? SOURCE.byteLength - 1 : Number(last);

    return new Response(SOURCE.subarray(start, end + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${SOURCE.byteLength}` },
    });
  });

  return { fetch, ranges };
}

/** The input ffmpeg was given and whether it was asked to seek to one second. */
interface FfmpegCall {
  input: string;
  seeking: boolean;
}

type FfmpegResult = "frame" | "empty" | "fail";

/**
 * A fake ffmpeg that reads its input the way ffmpeg does (two byte ranges over
 * HTTP, giving up on one after `readTimeoutMs`, or the local file), then writes
 * the frame `decide` picks. Like runCommand, it rejects with the abort reason
 * when the attempt is abandoned.
 */
function ffmpeg(
  decide: (call: FfmpegCall) => FfmpegResult = () => "frame",
  readTimeoutMs = 10_000,
) {
  const calls: { arguments_: readonly string[]; options: CommandOptions }[] = [];
  const run = vi.fn<CommandRunner>(async (_command, arguments_, options) => {
    calls.push({ arguments_, options });
    const input = arguments_[arguments_.indexOf("-i") + 1] ?? "";
    const output = arguments_.at(-1) ?? "";
    const call = { input, seeking: arguments_.includes("-ss") };
    try {
      if (input.startsWith("http://")) {
        for (const range of ["bytes=0-1023", "bytes=500000-500999"]) {
          const signals = [AbortSignal.timeout(readTimeoutMs)];
          if (options.signal !== undefined) signals.push(options.signal);
          const response = await fetch(input, {
            headers: { range },
            signal: AbortSignal.any(signals),
          });
          if (response.status !== 206) throw new Error("source unavailable");
          await response.arrayBuffer();
        }
      } else {
        await readFile(input);
      }
    } catch {
      options.signal?.throwIfAborted();
      throw new CommandFailure({
        command: "ffmpeg",
        exitCode: 1,
        stderrTail: "Input/output error",
      });
    }

    const result = decide(call);
    if (result === "fail") {
      throw new CommandFailure({ command: "ffmpeg", exitCode: 1, stderrTail: "" });
    }

    await writeFile(output, result === "frame" ? FRAME : new Uint8Array());

    return "";
  });

  return { run, calls };
}

function proxyArguments(url: string, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    "1",
    "-threads",
    "4",
    "-max_pixels",
    "33177600",
    "-format_whitelist",
    "mov,matroska,avi,mpegts,flv,ogg,asf,mpeg",
    "-protocol_whitelist",
    "http,tcp",
    "-multiple_requests",
    "1",
    "-rw_timeout",
    "150000000",
    "-i",
    url,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease",
    "-c:v",
    "libwebp",
    "-quality",
    "90",
    "-compression_level",
    "4",
    "-y",
    output,
  ];
}

async function refused(url: string): Promise<boolean> {
  return fetch(url).then(
    () => false,
    () => true,
  );
}

describe("video preview processor", () => {
  it("reads only the ranges ffmpeg asks for through a loopback proxy and reports the WebP size", async () => {
    const { input, output } = await paths();
    const source = origin();
    const capture = ffmpeg();

    const result = await processVideoPreview(
      { locator: LOCATOR, inputPath: input, outputPath: output },
      {
        fetch: source.fetch,
        runCommand: capture.run,
        allowedSourceOrigins: RULES,
        signal: ATTEMPT,
      },
    );

    expect({ ...result, bytes: Buffer.from(result.bytes).toString("base64") }).toEqual({
      bytes: FRAME.toString("base64"),
      width: 3,
      height: 5,
    });
    const url = capture.calls[0]?.arguments_[18] ?? "";
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/);
    expect(capture.calls.map(({ arguments_ }) => arguments_)).toEqual([
      proxyArguments(url, output),
    ]);
    expect(source.ranges).toEqual(["bytes=0-0", "bytes=0-1023", "bytes=500000-500999"]);
    await expect(access(input)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(refused(url)).resolves.toBe(true);
  });

  it("downloads the source and reads it locally when the origin ignores Range", async () => {
    const { input, output } = await paths();
    const source = origin(() => "whole");
    const capture = ffmpeg();

    await processVideoPreview(
      { locator: LOCATOR, inputPath: input, outputPath: output },
      {
        fetch: source.fetch,
        runCommand: capture.run,
        allowedSourceOrigins: RULES,
        signal: ATTEMPT,
      },
    );

    expect(Buffer.compare(await readFile(input), SOURCE)).toBe(0);
    expect(source.ranges).toEqual(["bytes=0-0"]);
    expect(capture.calls.map(({ arguments_ }) => arguments_.slice(11, 15))).toEqual([
      ["-protocol_whitelist", "file", "-i", input],
    ]);
  });

  it("falls back to a download when the origin stops honoring ranges mid-capture", async () => {
    const { input, output } = await paths();
    const source = origin((range, index) => (index === 0 || range === null ? "range" : "whole"));
    const capture = ffmpeg();

    const result = await processVideoPreview(
      { locator: LOCATOR, inputPath: input, outputPath: output },
      {
        fetch: source.fetch,
        runCommand: capture.run,
        allowedSourceOrigins: RULES,
        signal: ATTEMPT,
      },
    );

    expect(result).toMatchObject({ width: 3, height: 5 });
    expect(source.ranges).toEqual(["bytes=0-0", "bytes=0-1023", null]);
    expect(capture.calls.map(({ arguments_ }) => arguments_.includes(input))).toEqual([
      false,
      true,
    ]);
  });

  it("captures the first frame of a clip shorter than the one-second seek", async () => {
    const { input, output } = await paths();
    const capture = ffmpeg(({ seeking }) => (seeking ? "empty" : "frame"));

    const result = await processVideoPreview(
      { locator: LOCATOR, inputPath: input, outputPath: output },
      {
        fetch: origin().fetch,
        runCommand: capture.run,
        allowedSourceOrigins: RULES,
        signal: ATTEMPT,
      },
    );

    expect(result).toMatchObject({ width: 3, height: 5 });
    expect(capture.calls.map(({ arguments_ }) => arguments_.includes("-ss"))).toEqual([
      true,
      false,
    ]);
  });

  it("fails as corrupt only once a downloaded copy has no frame at one second or at the start", async () => {
    const { input, output } = await paths();
    const source = origin();
    const capture = ffmpeg(() => "fail");

    await expect(
      processVideoPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: source.fetch,
          runCommand: capture.run,
          allowedSourceOrigins: RULES,
          signal: ATTEMPT,
        },
      ),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "source_corrupt",
      retryable: false,
    });
    expect(
      capture.calls.map(({ arguments_ }) => ({
        local: arguments_.includes(input),
        seeking: arguments_.includes("-ss"),
      })),
    ).toEqual([
      { local: false, seeking: true },
      { local: false, seeking: false },
      { local: true, seeking: true },
      { local: true, seeking: false },
    ]);
    expect(source.ranges.at(-1)).toBeNull();
  });

  it("downloads the source when ffmpeg finds no frame through the proxy", async () => {
    const { input, output } = await paths();
    const source = origin();
    const capture = ffmpeg(({ input: location }) =>
      location.startsWith("http://") ? "fail" : "frame",
    );

    const result = await processVideoPreview(
      { locator: LOCATOR, inputPath: input, outputPath: output },
      {
        fetch: source.fetch,
        runCommand: capture.run,
        allowedSourceOrigins: RULES,
        signal: ATTEMPT,
      },
    );

    expect(result).toMatchObject({ width: 3, height: 5 });
    expect(Buffer.compare(await readFile(input), SOURCE)).toBe(0);
    expect(capture.calls.map(({ arguments_ }) => arguments_.includes(input))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("downloads the source when ffmpeg gives up on a read the origin has not answered", async () => {
    const { input, output } = await paths();
    const source = origin((range, index) => (index === 0 || range === null ? "range" : "hang"));
    const capture = ffmpeg(() => "frame", 100);

    const result = await processVideoPreview(
      { locator: LOCATOR, inputPath: input, outputPath: output },
      {
        fetch: source.fetch,
        runCommand: capture.run,
        allowedSourceOrigins: RULES,
        signal: ATTEMPT,
      },
    );

    expect(result).toMatchObject({ width: 3, height: 5 });
    expect(source.ranges).toEqual(["bytes=0-0", "bytes=0-1023", null]);
    expect(capture.calls.map(({ arguments_ }) => arguments_.includes(input))).toEqual([
      false,
      true,
    ]);
  });

  it("reports an origin failure during capture as retryable rather than blaming the video", async () => {
    const { input, output } = await paths();
    const capture = ffmpeg();

    await expect(
      processVideoPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: origin((_range, index) => (index === 0 ? "range" : { status: 503 })).fetch,
          runCommand: capture.run,
          allowedSourceOrigins: RULES,
          signal: ATTEMPT,
        },
      ),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "source_missing",
      retryable: true,
    });
    expect(capture.run).toHaveBeenCalledOnce();
  });

  it("rejects a source over the limit from its Content-Range before running ffmpeg", async () => {
    const { input, output } = await paths();
    const fetch_ = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([0]), {
          status: 206,
          headers: { "content-range": `bytes 0-0/${VIDEO_MAX_BYTES + 1}` },
        }),
    );
    const run = vi.fn<CommandRunner>();

    await expect(
      processVideoPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: fetch_,
          runCommand: run,
          allowedSourceOrigins: RULES,
          signal: ATTEMPT,
        },
      ),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "source_too_large",
      retryable: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["downgrades to HTTP", "http://media.example/video.mp4"],
    ["leaves the Space allowlist", "https://evil.example/video.mp4"],
  ])("rejects a redirect that %s before fetching it", async (_case, location) => {
    const { input, output } = await paths();
    const fetch_ = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 302, headers: { location } }),
    );

    await expect(
      processVideoPreview(
        { locator: "https://media.example/start", inputPath: input, outputPath: output },
        {
          fetch: fetch_,
          runCommand: vi.fn<CommandRunner>(),
          allowedSourceOrigins: RULES,
          signal: ATTEMPT,
        },
      ),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "source_missing",
      retryable: false,
    });
    expect(fetch_).toHaveBeenCalledOnce();
  });

  it("rejects with the attempt's reason and stops the proxy when the attempt is abandoned", async () => {
    const { input, output } = await paths();
    const controller = new AbortController();
    const reason = new Error("lease lost");
    let url = "";
    const run = vi.fn<CommandRunner>(async (_command, arguments_, options) => {
      url = arguments_[arguments_.indexOf("-i") + 1] ?? "";
      controller.abort(reason);
      options.signal?.throwIfAborted();

      return "";
    });

    await expect(
      processVideoPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: origin().fetch,
          runCommand: run,
          allowedSourceOrigins: RULES,
          signal: controller.signal,
        },
      ),
    ).rejects.toBe(reason);
    await expect(refused(url)).resolves.toBe(true);
  });
});
