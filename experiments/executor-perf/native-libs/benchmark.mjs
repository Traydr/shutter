#!/usr/bin/env node
/**
 * Native library / CLI optimization benchmarks for PDF and video thumbnail executors.
 *
 * Usage:
 *   node experiments/executor-perf/native-libs/benchmark.mjs [--iterations N] [--warmup N] [--output path]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pdfApproaches } from "./approaches/pdf.mjs";
import { videoApproaches } from "./approaches/video.mjs";
import { benchmarkApproach } from "./lib/bench.mjs";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "fixtures");
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

function toolVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split("\n")[0];
}

async function runSuite(label, approaches, fixturePath, iterations, warmup, bucket) {
  console.log(`\nBenchmarking ${label} (${iterations} iterations, ${warmup} warmup)...`);
  for (const [name, fn] of approaches) {
    try {
      process.stdout.write(`  ${name}... `);
      bucket[name] = await benchmarkApproach(name, fn, fixturePath, iterations, warmup);
      const row = bucket[name];
      console.log(
        `median ${row.medianMs.toFixed(0)}ms p95 ${row.p95Ms.toFixed(0)}ms ${row.outputBytes ?? "?"}B ${row.width ?? "?"}x${row.height ?? "?"}`,
      );
    } catch (error) {
      console.log(`FAILED: ${error.message}`);
      bucket[name] = { error: error.message };
    }
  }
}

async function main() {
  const { iterations, warmup, output } = parseArgs();
  const pdfFixture = join(FIXTURES, "sample-10page.pdf");
  const videoFixture1080 = join(FIXTURES, "sample-1080p-30s.mp4");
  const videoFixture720 = join(FIXTURES, "sample-720p-10s.mp4");

  const results = {
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      tools: {
        pdfinfo: toolVersion("pdfinfo", ["-v"]),
        pdftoppm: toolVersion("pdftoppm", ["-v"]),
        pdftocairo: toolVersion("pdftocairo", ["-v"]),
        mutool: toolVersion("mutool", ["-v"]),
        gs: toolVersion("gs", ["--version"]),
        ffmpeg: toolVersion("ffmpeg", ["-version"]),
        ffprobe: toolVersion("ffprobe", ["-version"]),
        webpmux: toolVersion("webpmux", ["-version"]),
      },
    },
    config: { iterations, warmup },
    baselineReference: {
      pdfMedianMs: 243,
      video1080MedianMs: 222,
      video720MedianMs: 144,
      source: "experiments/executor-perf/results/baseline.json (3 iterations)",
    },
    pdf: {},
    video: {},
  };

  await runSuite("PDF approaches", pdfApproaches, pdfFixture, iterations, warmup, results.pdf);

  console.log(`\nBenchmarking video approaches on 1080p/30s (${iterations} iterations)...`);
  for (const [name, fn] of videoApproaches) {
    const keyPrefix = "1080p";
    try {
      process.stdout.write(`  ${keyPrefix}-${name}... `);
      results.video[`${keyPrefix}-${name}`] = await benchmarkApproach(
        name,
        fn,
        videoFixture1080,
        iterations,
        warmup,
      );
      const row = results.video[`${keyPrefix}-${name}`];
      console.log(
        `median ${row.medianMs.toFixed(0)}ms p95 ${row.p95Ms.toFixed(0)}ms ${row.outputBytes ?? "?"}B`,
      );
    } catch (error) {
      console.log(`FAILED: ${error.message}`);
      results.video[`${keyPrefix}-${name}`] = { error: error.message };
    }
  }

  console.log(`\nBenchmarking video approaches on 720p/10s (${iterations} iterations)...`);
  for (const [name, fn] of videoApproaches) {
    const key = `720p-${name}`;
    try {
      process.stdout.write(`  ${key}... `);
      results.video[key] = await benchmarkApproach(name, fn, videoFixture720, iterations, warmup);
      const row = results.video[key];
      console.log(
        `median ${row.medianMs.toFixed(0)}ms p95 ${row.p95Ms.toFixed(0)}ms ${row.outputBytes ?? "?"}B`,
      );
    } catch (error) {
      console.log(`FAILED: ${error.message}`);
      results.video[key] = { error: error.message };
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
