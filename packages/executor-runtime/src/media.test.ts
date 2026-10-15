import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  CommandFailure,
  ProcessingFailure,
  parsePdfInfo,
  readWebpDimensions,
  runCommand,
  STDERR_TAIL_BYTES,
} from "./media.js";

/** Runs a Node script as the child process, so the tests need no media tools installed. */
function node(script: string): [string, string[]] {
  return [process.execPath, ["-e", script]];
}

async function rejection(promise: Promise<string>): Promise<Error> {
  const error = await promise.then(
    () => new Error("expected a rejection"),
    (cause: Error) => cause,
  );

  return error;
}

describe("runCommand", () => {
  it("resolves with stdout", async () => {
    const [command, arguments_] = node("process.stdout.write('hello')");

    await expect(runCommand(command, arguments_, { timeoutMs: 10_000 })).resolves.toBe("hello");
  });

  it("passes the command PATH but none of the Executor's credentials", async () => {
    process.env.S3_SECRET_ACCESS_KEY = "shutter-test-secret";
    process.env.EXECUTOR_ROLE_TOKEN = "shutter-test-role-token";
    onTestFinished(() => {
      delete process.env.S3_SECRET_ACCESS_KEY;
      delete process.env.EXECUTOR_ROLE_TOKEN;
    });
    const [command, arguments_] = node(
      "const { PATH, S3_SECRET_ACCESS_KEY, EXECUTOR_ROLE_TOKEN } = process.env; process.stdout.write(JSON.stringify({ PATH, S3_SECRET_ACCESS_KEY, EXECUTOR_ROLE_TOKEN }))",
    );

    await expect(runCommand(command, arguments_, { timeoutMs: 10_000 })).resolves.toBe(
      JSON.stringify({ PATH: process.env.PATH }),
    );
  });

  it("drains a megabyte of stderr instead of blocking on the full pipe", async () => {
    const [command, arguments_] = node(
      "process.stderr.write('x'.repeat(1024 * 1024), () => process.stdout.write('done'))",
    );
    const started = performance.now();

    await expect(runCommand(command, arguments_, { timeoutMs: 10_000 })).resolves.toBe("done");
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("rejects with the exit code and only a bounded stderr tail, kept out of the message", async () => {
    const [command, arguments_] = node(
      "process.stderr.write('a'.repeat(100000) + 'Command Line Error: Incorrect password\\n'); process.exitCode = 1",
    );

    const error = await rejection(runCommand(command, arguments_, { timeoutMs: 10_000 }));

    expect(error).toBeInstanceOf(CommandFailure);
    expect(error).toMatchObject({ exitCode: 1, message: `${command} exited with code 1` });
    if (!(error instanceof CommandFailure)) return;
    expect(error.stderrTail.length).toBe(STDERR_TAIL_BYTES);
    expect(error.stderrTail.endsWith("Command Line Error: Incorrect password\n")).toBe(true);
  });

  it("kills a command at its timeout", async () => {
    const [command, arguments_] = node("setTimeout(() => {}, 60000)");

    const error = await rejection(runCommand(command, arguments_, { timeoutMs: 200 }));

    expect(error).toBeInstanceOf(CommandFailure);
    expect(error).toMatchObject({ exitCode: null });
  });

  it("kills the command and rejects with the abort reason when the attempt is abandoned", async () => {
    const [command, arguments_] = node("setTimeout(() => {}, 60000)");
    const controller = new AbortController();
    const reason = new Error("lease lost");
    setTimeout(() => controller.abort(reason), 100);
    const started = performance.now();

    await expect(
      runCommand(command, arguments_, { timeoutMs: 60_000, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("does not start a command for an attempt that is already abandoned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shutter-run-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const marker = join(directory, "ran");
    const [command, arguments_] = node("require('fs').writeFileSync(process.argv[1], 'ran')");
    const reason = new Error("deadline");

    await expect(
      runCommand(command, [...arguments_, marker], {
        timeoutMs: 10_000,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects with the spawn error when the executable is missing", async () => {
    const error = await rejection(
      runCommand("shutter-test-missing-executable", [], { timeoutMs: 10_000 }),
    );

    expect(error).not.toBeInstanceOf(CommandFailure);
    expect(error).toMatchObject({ code: "ENOENT" });
  });

  it("rejects stdout beyond the report limit", async () => {
    const [command, arguments_] = node("process.stdout.write('y'.repeat(2 * 1024 * 1024))");

    await expect(runCommand(command, arguments_, { timeoutMs: 10_000 })).rejects.toBeInstanceOf(
      CommandFailure,
    );
  });

  describe("with stdinFrom", () => {
    const [producer, producerArguments] = node("process.stdout.write('p'.repeat(300000))");
    const [consumer, consumerArguments] = node(
      "let n = 0; process.stdin.on('data', (c) => { n += c.length }).on('end', () => process.stdout.write(String(n)))",
    );

    it("pipes the producer's stdout into the command", async () => {
      await expect(
        runCommand(consumer, consumerArguments, {
          timeoutMs: 10_000,
          stdinFrom: { command: producer, arguments: producerArguments },
        }),
      ).resolves.toBe("300000");
    });

    it("fails when the producer fails, even though the consumer exited 0", async () => {
      const [failing, failingArguments] = node(
        "process.stdout.write('partial'); process.exitCode = 3",
      );

      const error = await rejection(
        runCommand(consumer, consumerArguments, {
          timeoutMs: 10_000,
          stdinFrom: { command: failing, arguments: failingArguments },
        }),
      );

      expect(error).toBeInstanceOf(CommandFailure);
      expect(error).toMatchObject({ exitCode: 3, message: `${failing} exited with code 3` });
    });

    it("stops a producer whose consumer gave up, rather than waiting for the timeout", async () => {
      const [endless, endlessArguments] = node(
        "const chunk = 'e'.repeat(65536); (function write() { while (process.stdout.write(chunk)); process.stdout.once('drain', write) })()",
      );
      const [quitter, quitterArguments] = node("process.exitCode = 2");
      const started = performance.now();

      const error = await rejection(
        runCommand(quitter, quitterArguments, {
          timeoutMs: 60_000,
          stdinFrom: { command: endless, arguments: endlessArguments },
        }),
      );

      expect(error).toBeInstanceOf(CommandFailure);
      expect(performance.now() - started).toBeLessThan(5_000);
    });

    it("kills both commands when the attempt is abandoned", async () => {
      const [idle, idleArguments] = node("setTimeout(() => {}, 60000)");
      const controller = new AbortController();
      const reason = new Error("deadline");
      setTimeout(() => controller.abort(reason), 100);

      await expect(
        runCommand(idle, idleArguments, {
          timeoutMs: 60_000,
          signal: controller.signal,
          stdinFrom: { command: idle, arguments: idleArguments },
        }),
      ).rejects.toBe(reason);
    });
  });
});

// Real libwebp output (ffmpeg 7.1.5 on Debian trixie): `-c:v libwebp -quality 90` writes the simple
// lossy layout, `-lossless 1` the VP8L layout, and an alpha channel the extended VP8X layout.
const webp = {
  lossy3x5:
    "UklGRkAAAABXRUJQVlA4IDQAAAAwAgCdASoDAAUAAMASJaACdLoB+AH4AARoAAD++kXL/3easNN39a3/9aOfron+tHP/WVgA",
  lossless7x3: "UklGRhwAAABXRUJQVlA4TA8AAAAvBoAAAAcQ0f/+ByKi/wEA",
  alpha5x9:
    "UklGRmQAAABXRUJQVlA4WAoAAAAQAAAABAAACAAAQUxQSAoAAAABB9C/iAhERP8DVlA4IDQAAADwAQCdASoFAAkAAMASJaACdLoB+AAETAAA/vpFy/909e09e09fzB//it/xW/4rf/xOIAAA",
  /** The first 30 bytes of a 1920x1081 lossy frame: the header is all the parser reads. */
  lossy1920x1081Header: "UklGRrQOAABXRUJQVlA4IKgOAAAQugGdASqABzkE",
};

describe("readWebpDimensions", () => {
  it.each([
    ["lossy VP8", webp.lossy3x5, { width: 3, height: 5 }],
    ["lossless VP8L", webp.lossless7x3, { width: 7, height: 3 }],
    ["extended VP8X", webp.alpha5x9, { width: 5, height: 9 }],
    ["lossy VP8 at master size", webp.lossy1920x1081Header, { width: 1920, height: 1081 }],
  ])("reads the canvas size of a %s WebP", (_layout, base64, expected) => {
    expect(readWebpDimensions(Buffer.from(base64, "base64"))).toEqual(expected);
  });

  it.each([
    ["an empty file", new Uint8Array()],
    [
      "a PNG signature",
      Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000100000000", "hex"),
    ],
    ["a truncated header", Buffer.from(webp.lossy3x5, "base64").subarray(0, 20)],
  ])("rejects %s as a corrupt preview", (_case, bytes) => {
    expect(() => readWebpDimensions(bytes)).toThrow(ProcessingFailure);
  });
});

// Real `pdfinfo -f 1 -l 1 -box` output from poppler 25.03 (Debian trixie).
const pdfinfo = {
  a4: [
    "Producer:        shutter fixture",
    "Pages:           1",
    "Encrypted:       no",
    "Page    1 size:  595.28 x 841.89 pts (A4)",
    "Page    1 rot:   0",
    "Page    1 MediaBox:      0.00     0.00   595.28   841.89",
    "Page    1 CropBox:       0.00     0.00   595.28   841.89",
    "File size:       529 bytes",
    "PDF version:     1.7",
    "",
  ].join("\n"),
  rotated: [
    "Pages:           1",
    "Encrypted:       no",
    "Page    1 size:  300 x 300 pts",
    "Page    1 rot:   90",
    "Page    1 MediaBox:      0.00     0.00   600.00   300.00",
    "Page    1 CropBox:       0.00     0.00   300.00   300.00",
    "",
  ].join("\n"),
  /** A Title of `x\nPages: 7\nPage 1 rot: 90\nPage 1 MediaBox: 0 0 1 1\n`, printed verbatim before pdfinfo's own lines. */
  injectedTitle: [
    "Title:           x",
    "Pages:           7",
    "Page    1 rot:   90",
    "Page    1 MediaBox:      0.00     0.00     1.00     1.00",
    "",
    "Producer:        shutter fixture",
    "Pages:           1",
    "Encrypted:       no",
    "Page    1 size:  595.28 x 841.89 pts (A4)",
    "Page    1 rot:   0",
    "Page    1 MediaBox:      0.00     0.00   595.28   841.89",
    "",
  ].join("\n"),
};

describe("parsePdfInfo", () => {
  it("reads page one's MediaBox and rotation", () => {
    expect(parsePdfInfo(pdfinfo.a4)).toEqual({
      pages: 1,
      rotation: 0,
      width: 595.28,
      height: 841.89,
    });
    expect(parsePdfInfo(pdfinfo.rotated)).toEqual({
      pages: 1,
      rotation: 90,
      width: 600,
      height: 300,
    });
  });

  it("ignores page lines a document string smuggles in ahead of pdfinfo's own", () => {
    expect(parsePdfInfo(pdfinfo.injectedTitle)).toEqual({
      pages: 1,
      rotation: 0,
      width: 595.28,
      height: 841.89,
    });
  });

  it.each([
    ["no page lines", "Pages:           1\nEncrypted:       no\n"],
    ["no pages", "Pages:           0\n"],
    ["an empty MediaBox", pdfinfo.a4.replace("595.28   841.89\n", "0.00     0.00\n")],
    ["an unknown rotation", pdfinfo.a4.replace("rot:   0", "rot:   45")],
    ["a non-numeric box", pdfinfo.a4.replace("595.28   841.89\n", "nan   inf\n")],
  ])("returns nothing for %s", (_case, info) => {
    expect(parsePdfInfo(info)).toBeUndefined();
  });
});
