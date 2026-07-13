#!/usr/bin/env node
/**
 * Prototype video processor: optimized ffmpeg seek + webpmux dimensions (no ffprobe).
 *
 * Usage: node experiments/executor-perf/native-libs/prototypes/video-fast-seek.mjs <video-path> [output.webp]
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

const SCALE = "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease";

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

async function extractFrame(inputPath, outputPath) {
  const common = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    SCALE,
    "-c:v",
    "libwebp",
    "-quality",
    "90",
    "-y",
    outputPath,
  ];
  try {
    await run("ffmpeg", ["-ss", "1", "-noaccurate_seek", "-skip_frame", "nokey", ...common]);
  } catch {
    try {
      await run("ffmpeg", ["-ss", "1", "-noaccurate_seek", ...common]);
    } catch {
      await run("ffmpeg", common);
    }
  }
}

async function probeDimensions(outputPath) {
  const { stdout } = await run("webpmux", ["-info", outputPath]);
  const match = /Canvas size:\s+(\d+)\s+x\s+(\d+)/i.exec(stdout.toString("utf8"));
  if (!match) throw new Error("could not read webp dimensions");
  return { width: Number(match[1]), height: Number(match[2]) };
}

export async function processVideoPreview(inputPath, outputPath) {
  await extractFrame(inputPath, outputPath);
  const dims = await probeDimensions(outputPath);
  const bytes = await readFile(outputPath);
  return { bytes, ...dims };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: video-fast-seek.mjs <video-path> [output.webp]");
    process.exit(1);
  }
  const dir = await mkdtemp(join(tmpdir(), "video-fast-"));
  const outputPath = process.argv[3] ?? join(dir, `${basename(inputPath).replace(/\.[^.]+$/, "")}.webp`);
  try {
    const result = await processVideoPreview(inputPath, outputPath);
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
