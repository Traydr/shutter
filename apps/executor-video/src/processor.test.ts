import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProcessingFailure, processVideoPreview } from "./processor.js";

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

describe("video preview processor", () => {
  it("downloads over HTTPS, renders a bounded WebP, and reports dimensions", async () => {
    const { input, output } = await paths();
    const fetch_ = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "3" },
        }),
    ) as unknown as typeof fetch;
    const run = vi.fn((command: string, arguments_: readonly string[]) =>
      Effect.promise(async () => {
        if (command === "ffmpeg")
          await writeFile(arguments_.at(-1) as string, new Uint8Array([4, 5]));
        return command === "ffprobe"
          ? JSON.stringify({ streams: [{ width: 640, height: 360 }] })
          : "";
      }),
    );

    const result = await Effect.runPromise(
      processVideoPreview("https://media.example/video.mp4", input, output, {
        fetch: fetch_,
        runCommand: run,
        allowedSourceOrigins: [{ origin: "https://media.example" }],
      }),
    );
    expect({ ...result, bytes: [...result.bytes] }).toEqual({
      bytes: [4, 5],
      width: 640,
      height: 360,
    });
    expect(fetch_).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects a redirect that downgrades to HTTP before fetching it", async () => {
    const { input, output } = await paths();
    const fetch_ = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://media.example/video.mp4" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      Effect.runPromise(
        processVideoPreview("https://media.example/start", input, output, {
          fetch: fetch_,
          runCommand: vi.fn(),
          allowedSourceOrigins: [{ origin: "https://media.example" }],
        }),
      ),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "source_missing",
      retryable: false,
    });
    expect(fetch_).toHaveBeenCalledOnce();
  });

  it("rejects a redirect off the Space allowlist", async () => {
    const { input, output } = await paths();
    const fetch_ = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/video.mp4" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      Effect.runPromise(
        processVideoPreview("https://media.example/start", input, output, {
          fetch: fetch_,
          runCommand: vi.fn(),
          allowedSourceOrigins: [{ origin: "https://media.example" }],
        }),
      ),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "source_missing",
      retryable: false,
    });
    expect(fetch_).toHaveBeenCalledOnce();
  });
});
