#!/usr/bin/env node
/**
 * Prototype PDF processor: mutool draw (stdout) → ffmpeg (pipe) → webpmux dimensions.
 * Keeps pdfinfo for encryption/page validation; drops ffprobe.
 *
 * Usage: node experiments/executor-perf/native-libs/prototypes/pdf-mutool-pipe.mjs <pdf-path> [output.webp]
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

const SCALE = "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease";

async function run(command, args, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    if (stdin) stdin.pipe(child.stdin);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

async function validatePdf(inputPath) {
  const { stdout } = await run("pdfinfo", [inputPath]);
  const info = stdout.toString("utf8");
  if (/^Encrypted:\s+yes/im.test(info)) throw new Error("PDF is encrypted");
  const pages = /^Pages:\s+(\d+)/im.exec(info)?.[1];
  if (!pages || Number(pages) < 1) throw new Error("PDF has no pages");
}

async function renderToWebp(inputPath, outputPath) {
  await new Promise((resolve, reject) => {
    const mutool = spawn("mutool", ["draw", "-o", "-", "-r", "150", "-F", "png", inputPath, "1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-i",
        "pipe:0",
        "-vf",
        SCALE,
        "-c:v",
        "libwebp",
        "-quality",
        "90",
        "-y",
        outputPath,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    const stderr = [];
    mutool.stderr.on("data", (chunk) => stderr.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => stderr.push(chunk));
    mutool.stdout.pipe(ffmpeg.stdin);
    let mutoolCode;
    let ffmpegCode;
    const done = () => {
      if (mutoolCode === undefined || ffmpegCode === undefined) return;
      if (mutoolCode === 0 && ffmpegCode === 0) resolve();
      else reject(new Error(`render pipeline failed: ${Buffer.concat(stderr).toString("utf8")}`));
    };
    mutool.once("close", (code) => {
      mutoolCode = code;
      done();
    });
    ffmpeg.once("close", (code) => {
      ffmpegCode = code;
      done();
    });
    mutool.once("error", reject);
    ffmpeg.once("error", reject);
  });
}

async function probeDimensions(outputPath) {
  const { stdout } = await run("webpmux", ["-info", outputPath]);
  const match = /Canvas size:\s+(\d+)\s+x\s+(\d+)/i.exec(stdout.toString("utf8"));
  if (!match) throw new Error("could not read webp dimensions");
  return { width: Number(match[1]), height: Number(match[2]) };
}

export async function processPdfPreview(inputPath, outputPath) {
  await validatePdf(inputPath);
  await renderToWebp(inputPath, outputPath);
  const dims = await probeDimensions(outputPath);
  const bytes = await readFile(outputPath);
  return { bytes, ...dims };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: pdf-mutool-pipe.mjs <pdf-path> [output.webp]");
    process.exit(1);
  }
  const dir = await mkdtemp(join(tmpdir(), "pdf-mutool-"));
  const outputPath = process.argv[3] ?? join(dir, `${basename(inputPath, ".pdf")}.webp`);
  try {
    const result = await processPdfPreview(inputPath, outputPath);
    if (!process.argv[3]) await writeFile(outputPath, result.bytes);
    console.log(
      JSON.stringify(
        { outputPath, width: result.width, height: result.height, byteLength: result.bytes.byteLength },
        null,
        2,
      ),
    );
  } finally {
    if (!process.argv[3]) await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
