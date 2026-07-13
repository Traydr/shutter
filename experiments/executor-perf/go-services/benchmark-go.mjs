#!/usr/bin/env node
/**
 * Benchmark Go render services against Node.js subprocess baseline.
 *
 * Usage:
 *   node experiments/executor-perf/go-services/benchmark-go.mjs [--iterations N] [--warmup N]
 *
 * Modes:
 *   - CLI: invokes render-cli directly (no HTTP overhead) — primary comparison
 *   - HTTP: hits running Go services on ports 8091-8093
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "fixtures");
const BASELINE = join(ROOT, "results", "baseline.json");
const GO_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_ITERATIONS = 5;
const DEFAULT_WARMUP = 1;

function parseArgs() {
  const args = process.argv.slice(2);
  let iterations = DEFAULT_ITERATIONS;
  let warmup = DEFAULT_WARMUP;
  let mode = "cli";
  let output = join(GO_DIR, "results", "go-benchmark.json");
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--iterations" && args[i + 1]) iterations = Number(args[++i]);
    if (args[i] === "--warmup" && args[i + 1]) warmup = Number(args[++i]);
    if (args[i] === "--mode" && args[i + 1]) mode = args[++i];
    if (args[i] === "--output" && args[i + 1]) output = args[++i];
  }
  return { iterations, warmup, mode, output };
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

async function runCLI(approach, kind, inputPath) {
  const cli = join(GO_DIR, "bin", "render-cli");
  const start = performance.now();
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(cli, ["-approach", approach, "-kind", kind, "-input", inputPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.once("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err || `render-cli exited ${code}`));
    });
  });
  const elapsed = performance.now() - start;
  const parsed = JSON.parse(stdout);
  return { totalMs: elapsed, renderMs: parsed.totalMs, ...parsed };
}

async function runHTTP(port, kind, inputPath) {
  const body = JSON.stringify({ path: inputPath, kind });
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const bytes = (await response.arrayBuffer()).byteLength;
  const elapsed = performance.now() - start;
  return {
    totalMs: elapsed,
    renderMs: Number(response.headers.get("X-Render-Total-Ms") ?? elapsed),
    width: Number(response.headers.get("X-Render-Width")),
    height: Number(response.headers.get("X-Render-Height")),
    bytes,
    steps: JSON.parse(response.headers.get("X-Render-Steps") ?? "[]"),
  };
}

async function withLocalCopy(fixturePath, fn) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "shutter-go-perf-"));
  const ext = fixturePath.slice(fixturePath.lastIndexOf("."));
  const local = join(dir, `input${ext}`);
  await copyFile(fixturePath, local);
  try {
    return await fn(local);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function benchmark(name, fn, fixturePath, iterations, warmup) {
  const samples = [];
  let last = null;
  for (let i = 0; i < warmup + iterations; i += 1) {
    const result = await withLocalCopy(fixturePath, fn);
    if (i >= warmup) samples.push(result.totalMs);
    last = result;
  }
  return { name, ...stats(samples), outputBytes: last?.bytes, lastSteps: last?.steps, renderMs: last?.renderMs };
}

async function measureBinary(path) {
  const { stat } = await import("node:fs/promises");
  const s = await stat(path);
  return s.size;
}

async function measureColdStart(binary) {
  const start = performance.now();
  await new Promise((resolve, reject) => {
    const child = spawn(binary, ["-h"], { stdio: "ignore" });
    child.once("close", () => resolve());
    child.once("error", reject);
  });
  return performance.now() - start;
}

async function main() {
  const { iterations, warmup, mode, output } = parseArgs();
  const pdfFixture = join(FIXTURES, "sample-10page.pdf");
  const video1080 = join(FIXTURES, "sample-1080p-30s.mp4");
  const video720 = join(FIXTURES, "sample-720p-10s.mp4");

  const baseline = JSON.parse(await readFile(BASELINE, "utf8"));

  const cliApproaches = [
    ["go-subprocess-pdf", (p) => runCLI("subprocess", "pdf", p), pdfFixture],
    ["go-combined-pdf", (p) => runCLI("combined", "pdf", p), pdfFixture],
    ["go-fitz-pdf", (p) => runCLI("fitz", "pdf", p), pdfFixture],
    ["go-subprocess-video-1080p", (p) => runCLI("subprocess", "video", p), video1080],
    ["go-combined-video-1080p", (p) => runCLI("combined", "video", p), video1080],
    ["go-fitz-video-1080p", (p) => runCLI("fitz", "video", p), video1080],
    ["go-subprocess-video-720p", (p) => runCLI("subprocess", "video", p), video720],
    ["go-combined-video-720p", (p) => runCLI("combined", "video", p), video720],
    ["go-fitz-video-720p", (p) => runCLI("fitz", "video", p), video720],
  ];

  const httpServices = [
    ["go-http-subprocess-pdf", 8091, "pdf", pdfFixture],
    ["go-http-combined-pdf", 8092, "pdf", pdfFixture],
    ["go-http-fitz-pdf", 8093, "pdf", pdfFixture],
    ["go-http-subprocess-video-1080p", 8091, "video", video1080],
    ["go-http-combined-video-1080p", 8092, "video", video1080],
    ["go-http-fitz-video-1080p", 8093, "video", video1080],
  ];

  const results = {
    timestamp: new Date().toISOString(),
    mode,
    config: { iterations, warmup },
    environment: {
      go: (await runGoVersion()),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    binaries: {
      "render-cli": await measureBinary(join(GO_DIR, "bin", "render-cli")),
      "subprocess-svc": await measureBinary(join(GO_DIR, "bin", "subprocess-svc")),
      "combined-svc": await measureBinary(join(GO_DIR, "bin", "combined-svc")),
      "fitz-svc": await measureBinary(join(GO_DIR, "bin", "fitz-svc")),
    },
    baseline: {
      pdf: baseline.pdf["pdf-baseline-pdftoppm-ffmpeg"]?.medianMs,
      video1080: baseline.video["1080p-video-baseline-ss1-fallback"]?.medianMs,
      video720: baseline.video["720p-video-baseline-ss1-fallback"]?.medianMs,
    },
    pdf: {},
    video: {},
    http: {},
  };

  if (mode === "cli" || mode === "all") {
    console.log(`Benchmarking Go CLI approaches (${iterations} iterations)...`);
    for (const [name, fn, fixture] of cliApproaches) {
      try {
        process.stdout.write(`  ${name}... `);
        const r = await benchmark(name, fn, fixture, iterations, warmup);
        const bucket = name.includes("pdf") ? results.pdf : results.video;
        bucket[name] = r;
        console.log(`median ${r.medianMs.toFixed(0)}ms (render ${r.renderMs?.toFixed?.(0) ?? "?"}ms)`);
      } catch (e) {
        console.log(`FAILED: ${e.message}`);
        (name.includes("pdf") ? results.pdf : results.video)[name] = { error: e.message };
      }
    }
  }

  if (mode === "http" || mode === "all") {
    console.log(`\nBenchmarking Go HTTP services (${iterations} iterations)...`);
    for (const [name, port, kind, fixture] of httpServices) {
      try {
        process.stdout.write(`  ${name}... `);
        const r = await benchmark(name, (inputPath) => runHTTP(port, kind, inputPath), fixture, iterations, warmup);
        results.http[name] = r;
        console.log(`median ${r.medianMs.toFixed(0)}ms`);
      } catch (e) {
        console.log(`FAILED: ${e.message}`);
        results.http[name] = { error: e.message };
      }
    }
  }

  await mkdir(join(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${output}`);
}

function runGoVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn("go", ["version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.once("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error("go version failed"))));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
