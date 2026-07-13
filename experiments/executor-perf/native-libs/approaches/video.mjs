import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { ffmpegToWebpArgs, probeFfprobe, probeWebpmux, runCommand, runPipeline } from "../lib/bench.mjs";

const SCALE = "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease";

async function finalize(outputPath, probe = "webpmux") {
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

function ffmpegExtractArgs(inputPath, outputPath, extra = []) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...extra,
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
}

export async function videoBaseline(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  let ffmpeg;
  try {
    ffmpeg = await runCommand("ffmpeg", ffmpegExtractArgs(inputPath, outputPath, ["-ss", "1"]));
  } catch {
    ffmpeg = await runCommand("ffmpeg", ffmpegExtractArgs(inputPath, outputPath));
  }
  const probe = await probeFfprobe(outputPath);
  const meta = await finalize(outputPath, "ffprobe");
  return {
    totalMs: ffmpeg.durationMs + probe.durationMs,
    steps: { ffmpeg: ffmpeg.durationMs, ffprobe: probe.durationMs },
    ...meta,
  };
}

export async function videoBaselineWebpmux(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  let ffmpeg;
  try {
    ffmpeg = await runCommand("ffmpeg", ffmpegExtractArgs(inputPath, outputPath, ["-ss", "1"]));
  } catch {
    ffmpeg = await runCommand("ffmpeg", ffmpegExtractArgs(inputPath, outputPath));
  }
  const probe = await probeWebpmux(outputPath);
  const meta = await finalize(outputPath, "webpmux");
  return {
    totalMs: ffmpeg.durationMs + probe.durationMs,
    steps: { ffmpeg: ffmpeg.durationMs, webpmux: probe.durationMs },
    ...meta,
  };
}

export async function videoInputSeek(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    ["ffmpeg", () => runCommand("ffmpeg", ffmpegExtractArgs(inputPath, outputPath, ["-ss", "1"]))],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function videoFastSeek(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    [
      "ffmpeg",
      () => runCommand("ffmpeg", ffmpegExtractArgs(inputPath, outputPath, ["-ss", "1", "-noaccurate_seek"])),
    ],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function videoOutputSeek(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const ffmpeg = await runCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-ss",
      "1",
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
    ],
  );
  const probe = await probeWebpmux(outputPath);
  const meta = await finalize(outputPath, "webpmux");
  return {
    totalMs: ffmpeg.durationMs + probe.durationMs,
    steps: { ffmpeg: ffmpeg.durationMs, webpmux: probe.durationMs },
    ...meta,
  };
}

export async function videoSkipFrameNokey(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    [
      "ffmpeg",
      () =>
        runCommand("ffmpeg", ffmpegExtractArgs(inputPath, outputPath, ["-ss", "1", "-skip_frame", "nokey"])),
    ],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function videoFastSeekNokey(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    [
      "ffmpeg",
      () =>
        runCommand(
          "ffmpeg",
          ffmpegExtractArgs(inputPath, outputPath, ["-ss", "1", "-noaccurate_seek", "-skip_frame", "nokey"]),
        ),
    ],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export async function videoThumbnailFilter(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const ffmpeg = await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-vf",
    `thumbnail,${SCALE}`,
    "-frames:v",
    "1",
    "-c:v",
    "libwebp",
    "-quality",
    "90",
    "-y",
    outputPath,
  ]);
  const probe = await probeWebpmux(outputPath);
  const meta = await finalize(outputPath, "webpmux");
  return {
    totalMs: ffmpeg.durationMs + probe.durationMs,
    steps: { ffmpeg: ffmpeg.durationMs, webpmux: probe.durationMs },
    ...meta,
  };
}

export async function videoHwVaapi(dir, inputPath) {
  const outputPath = join(dir, "out.webp");
  const { totalMs, steps } = await runPipeline([
    [
      "ffmpeg",
      () =>
        runCommand("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-hwaccel",
          "vaapi",
          "-hwaccel_device",
          "/dev/dri/renderD128",
          "-ss",
          "1",
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
        ]),
    ],
    ["webpmux", async () => ({ durationMs: (await probeWebpmux(outputPath)).durationMs })],
  ]);
  const meta = await finalize(outputPath, "webpmux");
  return { totalMs, steps: { ...steps, webpmux: meta.probeMs }, ...meta };
}

export const videoApproaches = [
  ["video-baseline-ss1-ffprobe", videoBaseline],
  ["video-baseline-ss1-webpmux", videoBaselineWebpmux],
  ["video-input-seek-ss-before-i", videoInputSeek],
  ["video-fast-seek-noaccurate", videoFastSeek],
  ["video-output-seek-ss-after-i", videoOutputSeek],
  ["video-skip-frame-nokey", videoSkipFrameNokey],
  ["video-fast-seek-nokey", videoFastSeekNokey],
  ["video-thumbnail-filter", videoThumbnailFilter],
  ["video-hw-vaapi", videoHwVaapi],
];
