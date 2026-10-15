import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Command, CommandFailure } from "@shutter/executor-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  type ProcessingFailure,
  planPageRender,
  processPdfPreview,
} from "./processor.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function paths(): Promise<{ input: string; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), "shutter-pdf-test-"));
  directories.push(directory);

  return { input: join(directory, "source.pdf"), output: join(directory, "preview.webp") };
}

const LOCATOR = "https://media.example/file.pdf";
const RULES = [{ origin: "https://media.example" }];
/** An attempt that is never abandoned. */
const ATTEMPT = new AbortController().signal;

function pdfinfoReport(lines: {
  encrypted?: string;
  size: string;
  rot: string;
  mediaBox: string;
}): string {
  return [
    "Producer:        shutter fixture",
    "Custom Metadata: no",
    "Metadata Stream: no",
    "Tagged:          no",
    "UserProperties:  no",
    "Suspects:        no",
    "Form:            none",
    "JavaScript:      no",
    "Pages:           1",
    `Encrypted:       ${lines.encrypted ?? "no"}`,
    `Page    1 size:  ${lines.size}`,
    `Page    1 rot:   ${lines.rot}`,
    `Page    1 MediaBox:  ${lines.mediaBox}`,
    "File size:       529 bytes",
    "Optimized:       no",
    "PDF version:     1.7",
    "",
  ].join("\n");
}

const A4_BOX = "    0.00     0.00   595.28   841.89";

/**
 * Real poppler 25.03 results for fixtures built with qpdf 12.2 from one A4 page:
 * `--encrypt --owner-password=owner [--user-password=user] --bits=256` (AES-256)
 * and `--bits=128 --use-aes=n` (RC4).
 */
const pdfinfo = {
  plain: pdfinfoReport({ size: "595.28 x 841.89 pts (A4)", rot: "0", mediaBox: A4_BOX }),
  ownerAes256: pdfinfoReport({
    encrypted: "yes (print:yes copy:yes change:yes addNotes:yes algorithm:AES-256)",
    size: "595.28 x 841.89 pts (A4)",
    rot: "0",
    mediaBox: A4_BOX,
  }),
  ownerRc4: pdfinfoReport({
    encrypted: "yes (print:yes copy:yes change:yes addNotes:yes algorithm:RC4)",
    size: "595.28 x 841.89 pts (A4)",
    rot: "0",
    mediaBox: A4_BOX,
  }),
  rotated: pdfinfoReport({
    size: "300 x 300 pts",
    rot: "90",
    mediaBox: "    0.00     0.00   600.00   300.00",
  }),
  a0: pdfinfoReport({
    size: "2383.94 x 3370.39 pts (A0)",
    rot: "0",
    mediaBox: "    0.00     0.00  2383.94  3370.39",
  }),
  twoHundredInches: pdfinfoReport({
    size: "14400 x 14400 pts",
    rot: "0",
    mediaBox: "    0.00     0.00 14400.00 14400.00",
  }),
  userPassword: new CommandFailure({
    command: "pdfinfo",
    exitCode: 1,
    stderrTail: "Command Line Error: Incorrect password\n",
  }),
  truncated: new CommandFailure({
    command: "pdfinfo",
    exitCode: 1,
    stderrTail:
      "Syntax Error: End of file inside dictionary\nSyntax Error: Couldn't find trailer dictionary\nSyntax Error: Couldn't read xref table\n",
  }),
  noPages: new CommandFailure({
    command: "pdfinfo",
    exitCode: 99,
    stderrTail:
      "Syntax Error: Invalid page count 0\nCommand Line Error: Wrong page range given: the first page (1) can not be after the last page (0).\n",
  }),
};

/** The header libwebp writes for a lossy frame of this size; the processor reads nothing else. */
function webpHeader(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBPVP8 ", 8, "latin1");
  bytes.writeUInt32LE(10, 16);
  bytes.set([0x9d, 0x01, 0x2a], 23);
  bytes.writeUInt16LE(width, 26);
  bytes.writeUInt16LE(height, 28);

  return bytes;
}

interface Calls {
  run: ReturnType<typeof vi.fn<CommandRunner>>;
  commands: { command: string; arguments_: readonly string[]; stdinFrom: Command | undefined }[];
}

/** Fake poppler and ffmpeg: pdfinfo reports `info`; the render pipe writes a frame of `rendered` size. */
function tools(info: string | CommandFailure, rendered?: { width: number; height: number }): Calls {
  const commands: Calls["commands"] = [];
  const run = vi.fn<CommandRunner>(async (command, arguments_, options) => {
    commands.push({ command, arguments_, stdinFrom: options.stdinFrom });
    if (command === "pdfinfo") {
      if (info instanceof CommandFailure) throw info;

      return info;
    }

    if (rendered === undefined) {
      throw new CommandFailure({ command: "pdftoppm", exitCode: 1, stderrTail: "" });
    }

    await writeFile(arguments_.at(-1) ?? "", webpHeader(rendered.width, rendered.height));

    return "";
  });

  return { run, commands };
}

function renderCommands(input: string, output: string, longEdge: number): Calls["commands"] {
  return [
    { command: "pdfinfo", arguments_: ["-f", "1", "-l", "1", "-box", input], stdinFrom: undefined },
    {
      command: "ffmpeg",
      arguments_: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "pipe",
        "-f",
        "ppm_pipe",
        "-i",
        "pipe:0",
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
      ],
      stdinFrom: {
        command: "pdftoppm",
        arguments: ["-f", "1", "-l", "1", "-singlefile", "-scale-to", String(longEdge), input],
      },
    },
  ];
}

function source() {
  return vi.fn<typeof fetch>(async () => new Response(new Uint8Array([37, 80, 68, 70])));
}

describe("planPageRender", () => {
  it.each([
    [
      "A4 at 150 DPI",
      { width: 595.28, height: 841.89, rotation: 0 },
      { longEdge: 1754, width: 1241, height: 1754 },
    ],
    [
      "US Letter at 150 DPI",
      { width: 612, height: 792, rotation: 0 },
      { longEdge: 1650, width: 1275, height: 1650 },
    ],
    [
      "A0 inside the box",
      { width: 2383.94, height: 3370.39, rotation: 0 },
      { longEdge: 1920, width: 1359, height: 1920 },
    ],
    [
      "a 200-inch page inside the box",
      { width: 14400, height: 14400, rotation: 0 },
      { longEdge: 1920, width: 1920, height: 1920 },
    ],
    [
      "a landscape sheet inside the box",
      { width: 3370.39, height: 2383.94, rotation: 0 },
      { longEdge: 1920, width: 1920, height: 1359 },
    ],
    [
      "a page turned a quarter",
      { width: 600, height: 300, rotation: 90 },
      { longEdge: 1250, width: 625, height: 1250 },
    ],
    [
      "a sliver",
      { width: 14400, height: 3, rotation: 0 },
      { longEdge: 1920, width: 1920, height: 1 },
    ],
  ] as const)("sizes %s", (_case, page, expected) => {
    expect(planPageRender({ pages: 1, ...page })).toEqual(expected);
  });
});

describe("PDF preview processor", () => {
  it("renders page one straight to its target size through a PPM pipe, without PNG or ffprobe", async () => {
    const { input, output } = await paths();
    const calls = tools(pdfinfo.plain, { width: 1241, height: 1754 });

    const result = await processPdfPreview(
      { locator: LOCATOR, inputPath: input, outputPath: output },
      {
        fetch: source(),
        runCommand: calls.run,
        allowedSourceOrigins: RULES,
        signal: ATTEMPT,
      },
    );

    expect({ width: result.width, height: result.height }).toEqual({ width: 1241, height: 1754 });
    expect(calls.commands).toEqual(renderCommands(input, output, 1754));
  });

  it.each([
    ["an A0 sheet", pdfinfo.a0, 1920, { width: 1359, height: 1920 }],
    ["a 200-inch page", pdfinfo.twoHundredInches, 1920, { width: 1920, height: 1920 }],
    ["a rotated page", pdfinfo.rotated, 1250, { width: 625, height: 1250 }],
  ])("fits %s within the 1920-pixel box", async (_case, info, longEdge, rendered) => {
    const { input, output } = await paths();
    const calls = tools(info, rendered);

    await expect(
      processPdfPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: source(),
          runCommand: calls.run,
          allowedSourceOrigins: RULES,
          signal: ATTEMPT,
        },
      ),
    ).resolves.toMatchObject(rendered);
    expect(calls.commands[1]?.stdinFrom?.arguments).toContain(String(longEdge));
  });

  it.each([
    ["AES-256", pdfinfo.ownerAes256],
    ["RC4", pdfinfo.ownerRc4],
  ])("renders a %s PDF that has only an owner password", async (_cipher, info) => {
    const { input, output } = await paths();
    const calls = tools(info, { width: 1241, height: 1754 });

    await expect(
      processPdfPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: source(),
          runCommand: calls.run,
          allowedSourceOrigins: RULES,
          signal: ATTEMPT,
        },
      ),
    ).resolves.toMatchObject({ width: 1241, height: 1754 });
  });

  it("returns the stable password-protected failure for a PDF that needs a user password", async () => {
    const { input, output } = await paths();
    // poppler reports AES-256 and RC4 user passwords identically.
    const calls = tools(pdfinfo.userPassword, { width: 1241, height: 1754 });

    await expect(
      processPdfPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: source(),
          runCommand: calls.run,
          allowedSourceOrigins: RULES,
          signal: ATTEMPT,
        },
      ),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "pdf_password_protected",
      retryable: false,
    });
    expect(calls.commands.map(({ command }) => command)).toEqual(["pdfinfo"]);
  });

  it.each([
    ["a truncated file", pdfinfo.truncated],
    ["a document with no pages", pdfinfo.noPages],
    ["metadata without page one", "Pages:           1\nEncrypted:       no\n"],
  ])("fails %s as corrupt", async (_case, info) => {
    const { input, output } = await paths();
    const calls = tools(info, { width: 1241, height: 1754 });

    await expect(
      processPdfPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: source(),
          runCommand: calls.run,
          allowedSourceOrigins: RULES,
          signal: ATTEMPT,
        },
      ),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "source_corrupt",
      retryable: false,
    });
    expect(calls.commands.map(({ command }) => command)).toEqual(["pdfinfo"]);
  });

  it("fails as corrupt when the render pipe fails", async () => {
    const { input, output } = await paths();

    await expect(
      processPdfPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: source(),
          runCommand: tools(pdfinfo.plain).run,
          allowedSourceOrigins: RULES,
          signal: ATTEMPT,
        },
      ),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "source_corrupt",
      retryable: false,
    });
  });

  it("refuses a render that came back at the wrong size, such as poppler's 1x1 placeholder", async () => {
    const { input, output } = await paths();

    await expect(
      processPdfPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: source(),
          runCommand: tools(pdfinfo.twoHundredInches, { width: 1, height: 1 }).run,
          allowedSourceOrigins: RULES,
          signal: ATTEMPT,
        },
      ),
    ).rejects.toMatchObject<Partial<ProcessingFailure>>({
      code: "source_corrupt",
      retryable: false,
    });
  });

  it("rejects with the attempt's reason when the attempt is abandoned", async () => {
    const { input, output } = await paths();
    const controller = new AbortController();
    const reason = new Error("deadline");
    const run = vi.fn<CommandRunner>(async (command, _arguments, options) => {
      if (command === "pdfinfo") return pdfinfo.plain;

      controller.abort(reason);
      options.signal?.throwIfAborted();

      return "";
    });

    await expect(
      processPdfPreview(
        { locator: LOCATOR, inputPath: input, outputPath: output },
        {
          fetch: source(),
          runCommand: run,
          allowedSourceOrigins: RULES,
          signal: controller.signal,
        },
      ),
    ).rejects.toBe(reason);
  });
});
