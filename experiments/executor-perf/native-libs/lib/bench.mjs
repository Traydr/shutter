import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  return {
    samples,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    meanMs: sum / sorted.length,
    medianMs: sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

export async function runCommand(command, args, { timeoutMs = 600_000, capture = "stdout" } = {}) {
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      } else {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`${command} exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
  return { durationMs: performance.now() - start, ...result };
}

export async function runPipeline(steps) {
  const timings = {};
  let totalMs = 0;
  for (const [name, fn] of steps) {
    const result = await fn();
    timings[name] = result.durationMs;
    totalMs += result.durationMs;
  }
  return { totalMs, steps: timings };
}

export async function withWorkdir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "shutter-native-perf-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function stageInput(dir, inputPath) {
  const ext = inputPath.slice(inputPath.lastIndexOf("."));
  const localInput = join(dir, `input${ext}`);
  await writeFile(localInput, await readFile(inputPath));
  return localInput;
}

const FFMPEG_SCALE = "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease";
const FFMPEG_WEBP = ["-c:v", "libwebp", "-quality", "90"];

export function ffmpegToWebpArgs(input, output, { vf = FFMPEG_SCALE } = {}) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-vf",
    vf,
    ...FFMPEG_WEBP,
    "-y",
    output,
  ];
}

export function ffmpegPipeWebpArgs(output, { inputFormat } = {}) {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (inputFormat) args.push("-f", inputFormat);
  args.push("-i", "pipe:0", "-vf", FFMPEG_SCALE, ...FFMPEG_WEBP, "-y", output);
  return args;
}

export async function probeFfprobe(outputPath) {
  const { durationMs, stdout } = await runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    outputPath,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  return {
    durationMs,
    width: stream?.width,
    height: stream?.height,
  };
}

export async function probeWebpmux(outputPath) {
  const { durationMs, stdout } = await runCommand("webpmux", ["-info", outputPath]);
  const match = /Canvas size:\s+(\d+)\s+x\s+(\d+)/i.exec(stdout);
  if (!match) throw new Error(`webpmux could not parse dimensions: ${stdout.trim()}`);
  return {
    durationMs,
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

export async function pipeRenderToWebp({ render, outputPath, inputFormat = "image2pipe" }) {
  const start = performance.now();
  await new Promise((resolve, reject) => {
    const renderer = spawn(render.command, render.args, { stdio: ["ignore", "pipe", "pipe"] });
    const ffmpeg = spawn("ffmpeg", ffmpegPipeWebpArgs(outputPath, { inputFormat }), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stderr = [];
    renderer.stderr.on("data", (chunk) => stderr.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => stderr.push(chunk));
    renderer.stdout.pipe(ffmpeg.stdin);
    renderer.stdout.on("error", reject);
    ffmpeg.stdin.on("error", reject);
    let rendererCode;
    let ffmpegCode;
    const maybeDone = () => {
      if (rendererCode === undefined || ffmpegCode === undefined) return;
      if (rendererCode === 0 && ffmpegCode === 0) resolve();
      else {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            `pipe pipeline failed (renderer=${rendererCode ?? "?"}, ffmpeg=${ffmpegCode ?? "?"}): ${detail}`,
          ),
        );
      }
    };
    renderer.once("close", (code) => {
      rendererCode = code;
      maybeDone();
    });
    ffmpeg.once("close", (code) => {
      ffmpegCode = code;
      maybeDone();
    });
    renderer.once("error", reject);
    ffmpeg.once("error", reject);
  });
  return { durationMs: performance.now() - start };
}

export async function benchmarkApproach(name, fn, inputPath, iterations, warmup) {
  const samples = [];
  let lastResult = null;
  for (let i = 0; i < warmup + iterations; i += 1) {
    const result = await withWorkdir(async (dir) => {
      const localInput = await stageInput(dir, inputPath);
      return fn(dir, localInput);
    });
    if (i >= warmup) samples.push(result.totalMs);
    lastResult = result;
  }
  return {
    name,
    ...stats(samples),
    outputBytes: lastResult?.bytes,
    width: lastResult?.width,
    height: lastResult?.height,
    lastSteps: lastResult?.steps,
    error: lastResult?.error,
  };
}
