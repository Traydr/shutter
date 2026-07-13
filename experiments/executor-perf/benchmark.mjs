#!/usr/bin/env node
/**
 * Executor thumbnail performance benchmark harness.
 * Measures wall-clock time for render pipelines (excludes network download).
 *
 * Usage:
 *   node experiments/executor-perf/benchmark.mjs [--iterations N] [--warmup N] [--output path]
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const FIXTURES = join(import.meta.dirname, "fixtures");
const DEFAULT_ITERATIONS = 5;
const DEFAULT_WARMUP = 1;

function parseArgs() {
  const args = process.argv.slice(2);
  let iterations = DEFAULT_ITERATIONS;
  let warmup = DEFAULT_WARMUP;
  let output = join(import.meta.dirname, "results", "latest.json");
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--iterations" && args[i + 1]) iterations = Number(args[++i]);
    if (args[i] === "--warmup" && args[i + 1]) warmup = Number(args[++i]);
    if (args[i] === "--output" && args[i + 1]) output = args[++i];
  }
  return { iterations, warmup, output };
}

async function runCommand(command, args, timeoutMs = 600_000) {
  const start = performance.now();
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
  return performance.now() - start;
}

async function withWorkdir(fn) {
  const dir = await mkdtemp();
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function mkdtemp() {
  const { mkdtemp: mk } = await import("node:fs/promises");
  return mk(join(tmpdir(), "shutter-perf-"));
}

function stats(samples) {
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

// --- PDF approaches ---

async function pdfBaseline(dir, inputPath) {
  const pagePrefix = join(dir, "page");
  const outputPath = join(dir, "out.webp");
  const t1 = await runCommand("pdfinfo", [inputPath]);
  const t2 = await runCommand("pdftoppm", ["-f", "1", "-singlefile", "-png", "-r", "150", inputPath, pagePrefix]);
  const t3 = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", `${pagePrefix}.png`,
    "-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
    "-c:v", "libwebp", "-quality", "90", "-y", outputPath,
  ]);
  const t4 = await runCommand("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", outputPath,
  ]);
  const bytes = (await readFile(outputPath)).byteLength;
  return { totalMs: t1 + t2 + t3 + t4, steps: { pdfinfo: t1, pdftoppm: t2, ffmpeg: t3, ffprobe: t4 }, bytes };
}

async function pdfFfmpegDirect(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const t1 = await runCommand("pdfinfo", [inputPath]);
  const t2 = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", inputPath,
    "-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
    "-frames:v", "1",
    "-c:v", "libwebp", "-quality", "90", "-y", outputPath,
  ]);
  const t3 = await runCommand("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", outputPath,
  ]);
  const bytes = (await readFile(outputPath)).byteLength;
  return { totalMs: t1 + t2 + t3, steps: { pdfinfo: t1, ffmpeg: t2, ffprobe: t3 }, bytes };
}

async function pdfGhostscriptWebp(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const t1 = await runCommand("pdfinfo", [inputPath]);
  const t2 = await runCommand("gs", [
    "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
    "-sDEVICE=webp", "-dWebPLossless=false", "-dWebPQuality=90",
    "-r150", "-dFirstPage=1", "-dLastPage=1",
    `-sOutputFile=${outputPath}`, inputPath,
  ]);
  const t3 = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", outputPath,
    "-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
    "-c:v", "libwebp", "-quality", "90", "-y", join(dir, "scaled.webp"),
  ]);
  const bytes = (await readFile(join(dir, "scaled.webp"))).byteLength;
  return { totalMs: t1 + t2 + t3, steps: { pdfinfo: t1, ghostscript: t2, ffmpeg_scale: t3 }, bytes };
}

async function pdfPdftocairo(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const t1 = await runCommand("pdfinfo", [inputPath]);
  const t2 = await runCommand("pdftocairo", [
    "-f", "1", "-l", "1", "-singlefile", "-webp", "-r", "150", inputPath, join(dir, "page"),
  ]);
  const t3 = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", `${join(dir, "page")}.webp`,
    "-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
    "-c:v", "libwebp", "-quality", "90", "-y", outputPath,
  ]);
  const bytes = (await readFile(outputPath)).byteLength;
  return { totalMs: t1 + t2 + t3, steps: { pdfinfo: t1, pdftocairo: t2, ffmpeg: t3 }, bytes };
}

async function pdfPdftocairoDirect(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const t1 = await runCommand("pdfinfo", [inputPath]);
  const t2 = await runCommand("pdftocairo", [
    "-f", "1", "-l", "1", "-singlefile", "-webp", "-r", "150", inputPath, join(dir, "page"),
  ]);
  const bytes = (await readFile(`${join(dir, "page")}.webp`)).byteLength;
  return { totalMs: t1 + t2, steps: { pdfinfo: t1, pdftocairo: t2 }, bytes };
}

// --- Video approaches ---

async function videoBaseline(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  let t1;
  try {
    t1 = await runCommand("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-ss", "1", "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
      "-c:v", "libwebp", "-quality", "90", "-y", outputPath,
    ]);
  } catch {
    t1 = await runCommand("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
      "-c:v", "libwebp", "-quality", "90", "-y", outputPath,
    ]);
  }
  const t2 = await runCommand("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", outputPath,
  ]);
  const bytes = (await readFile(outputPath)).byteLength;
  return { totalMs: t1 + t2, steps: { ffmpeg: t1, ffprobe: t2 }, bytes };
}

async function videoFastSeek(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const t1 = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-ss", "1", "-noaccurate_seek",
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
    "-c:v", "libwebp", "-quality", "90", "-y", outputPath,
  ]);
  const bytes = (await readFile(outputPath)).byteLength;
  return { totalMs: t1, steps: { ffmpeg: t1 }, bytes };
}

async function videoInputSeek(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const t1 = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-ss", "1", "-i", inputPath,
    "-frames:v", "1",
    "-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
    "-c:v", "libwebp", "-quality", "90", "-y", outputPath,
  ]);
  const bytes = (await readFile(outputPath)).byteLength;
  return { totalMs: t1, steps: { ffmpeg: t1 }, bytes };
}

async function videoThumbnailFilter(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const t1 = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", inputPath,
    "-vf", "thumbnail,scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
    "-frames:v", "1",
    "-c:v", "libwebp", "-quality", "90", "-y", outputPath,
  ]);
  const bytes = (await readFile(outputPath)).byteLength;
  return { totalMs: t1, steps: { ffmpeg: t1 }, bytes };
}

async function benchmarkApproach(name, fn, inputPath, iterations, warmup) {
  const samples = [];
  let lastResult = null;
  for (let i = 0; i < warmup + iterations; i += 1) {
    const result = await withWorkdir(async (dir) => {
      const localInput = join(dir, "input" + inputPath.slice(inputPath.lastIndexOf(".")));
      await writeFile(localInput, await readFile(inputPath));
      return fn(dir, localInput);
    });
    if (i >= warmup) samples.push(result.totalMs);
    lastResult = result;
  }
  return { name, ...stats(samples), outputBytes: lastResult?.bytes, lastSteps: lastResult?.steps };
}

async function main() {
  const { iterations, warmup, output } = parseArgs();
  const pdfFixture = join(FIXTURES, "sample-10page.pdf");
  const videoFixture1080 = join(FIXTURES, "sample-1080p-30s.mp4");
  const videoFixture720 = join(FIXTURES, "sample-720p-10s.mp4");

  const pdfApproaches = [
    ["pdf-baseline-pdftoppm-ffmpeg", pdfBaseline],
    ["pdf-ffmpeg-direct", pdfFfmpegDirect],
    ["pdf-ghostscript-webp", pdfGhostscriptWebp],
    ["pdf-pdftocairo-ffmpeg", pdfPdftocairo],
    ["pdf-pdftocairo-direct", pdfPdftocairoDirect],
  ];

  const videoApproaches = [
    ["video-baseline-ss1-fallback", videoBaseline],
    ["video-fast-seek-noaccurate", videoFastSeek],
    ["video-input-seek-ss-before-i", videoInputSeek],
    ["video-thumbnail-filter", videoThumbnailFilter],
  ];

  const results = {
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: { iterations, warmup },
    pdf: {},
    video: {},
  };

  console.log(`Benchmarking PDF approaches (${iterations} iterations, ${warmup} warmup)...`);
  for (const [name, fn] of pdfApproaches) {
    try {
      process.stdout.write(`  ${name}... `);
      results.pdf[name] = await benchmarkApproach(name, fn, pdfFixture, iterations, warmup);
      console.log(`median ${results.pdf[name].medianMs.toFixed(0)}ms`);
    } catch (error) {
      console.log(`FAILED: ${error.message}`);
      results.pdf[name] = { error: error.message };
    }
  }

  console.log(`\nBenchmarking video approaches on 1080p/30s (${iterations} iterations)...`);
  for (const [name, fn] of videoApproaches) {
    try {
      process.stdout.write(`  ${name}... `);
      results.video[`1080p-${name}`] = await benchmarkApproach(name, fn, videoFixture1080, iterations, warmup);
      console.log(`median ${results.video[`1080p-${name}`].medianMs.toFixed(0)}ms`);
    } catch (error) {
      console.log(`FAILED: ${error.message}`);
      results.video[`1080p-${name}`] = { error: error.message };
    }
  }

  console.log(`\nBenchmarking video approaches on 720p/10s (${iterations} iterations)...`);
  for (const [name, fn] of videoApproaches) {
    try {
      process.stdout.write(`  ${name}... `);
      results.video[`720p-${name}`] = await benchmarkApproach(name, fn, videoFixture720, iterations, warmup);
      console.log(`median ${results.video[`720p-${name}`].medianMs.toFixed(0)}ms`);
    } catch (error) {
      console.log(`FAILED: ${error.message}`);
      results.video[`720p-${name}`] = { error: error.message };
    }
  }

  await mkdir(join(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
