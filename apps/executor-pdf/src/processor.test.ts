import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProcessingFailure, processPdfPreview } from "./processor.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function paths(): Promise<{ input: string; prefix: string; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), "shutter-pdf-test-"));
  directories.push(directory);
  return {
    input: join(directory, "source.pdf"),
    prefix: join(directory, "page"),
    output: join(directory, "preview.webp"),
  };
}

describe("PDF preview processor", () => {
  it("renders page one to a bounded WebP and reports dimensions", async () => {
    const { input, prefix, output } = await paths();
    const fetch_ = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3])),
    ) as unknown as typeof fetch;
    const run = vi.fn(async (command: string, arguments_: readonly string[]) => {
      if (command === "pdfinfo") return "Pages: 2\nEncrypted: no\n";
      if (command === "ffmpeg")
        await writeFile(arguments_.at(-1) as string, new Uint8Array([6, 7]));
      return command === "ffprobe"
        ? JSON.stringify({ streams: [{ width: 800, height: 1200 }] })
        : "";
    });

    const result = await processPdfPreview(
      "https://media.example/file.pdf",
      input,
      prefix,
      output,
      {
        fetch: fetch_,
        runCommand: run,
      },
    );
    expect({ ...result, bytes: [...result.bytes] }).toEqual({
      bytes: [6, 7],
      width: 800,
      height: 1200,
    });
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("returns the stable password-protected failure before rendering", async () => {
    const { input, prefix, output } = await paths();
    const fetch_ = vi.fn(async () => new Response(new Uint8Array([1]))) as unknown as typeof fetch;

    await expect(
      processPdfPreview("https://media.example/file.pdf", input, prefix, output, {
        fetch: fetch_,
        runCommand: vi.fn(async () => "Pages: 1\nEncrypted: yes\n"),
      }),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "pdf_password_protected",
      retryable: false,
    });
  });
});
