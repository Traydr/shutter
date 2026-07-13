import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  ffmpegToWebpArgs,
  pipeRenderToWebp,
  probeFfprobe,
  probeWebpmux,
  runCommand,
  runPipeline,
} from "../lib/bench.mjs";

async function finalize(dir, outputPath, probe = "webpmux") {
  const bytes = (await readFile(outputPath)).byteLength;
  const probeFn = probe === "ffprobe" ? probeFfprobe : probeWebpmux;
  const dims = await probeFn(outputPath);
  return {
    bytes,
    width: dims.width,
    height: dims.height,
    probeMs: dims.durationMs,
    probe,
  };
}

export async function pdfBaseline(dir, inputPath) {
  const pagePrefix = join(dir, "page");
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    ["pdftoppm", () => runCommand("pdftoppm", ["-f", "1", "-singlefile", "-png", "-r", "150", inputPath, pagePrefix])],
    ["ffmpeg", () => runCommand("ffmpeg", ffmpegToWebpArgs(`${pagePrefix}.png`, outputPath))],
    ["ffprobe", async () => ({ durationMs: (await probeFfprobe(outputPath)).durationMs })],
  ]);
  const meta = await finalize(dir, outputPath, "ffprobe");
  return { totalMs, steps: { ...steps, ffprobe: meta.probeMs }, ...meta };
}

export async function pdfBaselineWebpmux(dir, inputPath) {
  const pagePrefix = join(dir, "page");
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    ["pdftoppm", () => runCommand("pdftoppm", ["-f", "1", "-singlefile", "-png", "-r", "150", inputPath, pagePrefix])],
    ["ffmpeg", () => runCommand("ffmpeg", ffmpegToWebpArgs(`${pagePrefix}.png`, outputPath))],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(dir, outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function pdfMutoolPipe(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    [
      "mutool_ffmpeg_pipe",
      () =>
        pipeRenderToWebp({
          render: {
            command: "mutool",
            args: ["draw", "-o", "-", "-r", "150", "-F", "png", inputPath, "1"],
          },
          outputPath,
        }),
    ],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(dir, outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function pdfMutoolFile(dir, inputPath) {
  const pngPath = join(dir, "page.png");
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    ["mutool", () => runCommand("mutool", ["draw", "-o", pngPath, "-r", "150", "-F", "png", inputPath, "1"])],
    ["ffmpeg", () => runCommand("ffmpeg", ffmpegToWebpArgs(pngPath, outputPath))],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(dir, outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function pdfGhostscriptJpegPipe(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    [
      "gs_ffmpeg_pipe",
      () =>
        pipeRenderToWebp({
          render: {
            command: "gs",
            args: [
              "-q",
              "-dNOPAUSE",
              "-dBATCH",
              "-dSAFER",
              "-sDEVICE=jpeg",
              "-dJPEGQ=95",
              "-r150",
              "-dFirstPage=1",
              "-dLastPage=1",
              "-sOutputFile=-",
              inputPath,
            ],
          },
          outputPath,
          inputFormat: "image2pipe",
        }),
    ],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(dir, outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function pdfGhostscriptPngPipe(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    [
      "gs_ffmpeg_pipe",
      () =>
        pipeRenderToWebp({
          render: {
            command: "gs",
            args: [
              "-q",
              "-dNOPAUSE",
              "-dBATCH",
              "-dSAFER",
              "-sDEVICE=png16m",
              "-r150",
              "-dFirstPage=1",
              "-dLastPage=1",
              "-sOutputFile=-",
              inputPath,
            ],
          },
          outputPath,
        }),
    ],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(dir, outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function pdfPdftocairoPng(dir, inputPath) {
  const pagePrefix = join(dir, "page");
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    [
      "pdftocairo",
      () => runCommand("pdftocairo", ["-f", "1", "-l", "1", "-singlefile", "-png", "-r", "150", inputPath, pagePrefix]),
    ],
    ["ffmpeg", () => runCommand("ffmpeg", ffmpegToWebpArgs(`${pagePrefix}.png`, outputPath))],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(dir, outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function pdfPdftoppmLowerDpi(dir, inputPath) {
  const pagePrefix = join(dir, "page");
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    ["pdftoppm", () => runCommand("pdftoppm", ["-f", "1", "-singlefile", "-png", "-r", "100", inputPath, pagePrefix])],
    ["ffmpeg", () => runCommand("ffmpeg", ffmpegToWebpArgs(`${pagePrefix}.png`, outputPath))],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(dir, outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function pdfFfmpegDirect(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    [
      "ffmpeg",
      () =>
        runCommand("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          inputPath,
          "-vf",
          "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
          "-frames:v",
          "1",
          "-c:v",
          "libwebp",
          "-quality",
          "90",
          "-y",
          outputPath,
        ]),
    ],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(dir, outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function pdfGhostscriptWebp(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    [
      "ghostscript",
      () =>
        runCommand("gs", [
          "-q",
          "-dNOPAUSE",
          "-dBATCH",
          "-dSAFER",
          "-sDEVICE=webp",
          "-dWebPLossless=false",
          "-dWebPQuality=90",
          "-r150",
          "-dFirstPage=1",
          "-dLastPage=1",
          `-sOutputFile=${outputPath}`,
          inputPath,
        ]),
    ],
  ]);
  const meta = await finalize(dir, outputPath, "webpmux");
  return { totalMs, steps, ...meta };
}

export async function pdfPdftocairoWebp(dir, inputPath) {
  const pagePrefix = join(dir, "page");
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["pdfinfo", () => runCommand("pdfinfo", [inputPath])],
    [
      "pdftocairo",
      () => runCommand("pdftocairo", ["-f", "1", "-l", "1", "-singlefile", "-webp", "-r", "150", inputPath, pagePrefix]),
    ],
    ["ffmpeg", () => runCommand("ffmpeg", ffmpegToWebpArgs(`${pagePrefix}.webp`, outputPath))],
  ]);
  const meta = await finalize(dir, outputPath, "webpmux");
  return { totalMs, steps, ...meta };
}

export const pdfApproaches = [
  ["pdf-baseline-pdftoppm-ffprobe", pdfBaseline],
  ["pdf-baseline-webpmux-probe", pdfBaselineWebpmux],
  ["pdf-mutool-pipe-ffmpeg", pdfMutoolPipe],
  ["pdf-mutool-file-ffmpeg", pdfMutoolFile],
  ["pdf-gs-jpeg-pipe-ffmpeg", pdfGhostscriptJpegPipe],
  ["pdf-gs-png-pipe-ffmpeg", pdfGhostscriptPngPipe],
  ["pdf-pdftocairo-png-ffmpeg", pdfPdftocairoPng],
  ["pdf-pdftoppm-100dpi-ffmpeg", pdfPdftoppmLowerDpi],
  ["pdf-ffmpeg-direct", pdfFfmpegDirect],
  ["pdf-ghostscript-webp", pdfGhostscriptWebp],
  ["pdf-pdftocairo-webp", pdfPdftocairoWebp],
];
