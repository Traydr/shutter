import { readFile } from "node:fs/promises";
import {
  CommandFailure,
  type CommandOptions,
  type CommandRunner,
  downloadSource,
  MASTER_PREVIEW_ENCODER_OPTIONS,
  MASTER_PREVIEW_SCALE_FILTER,
  type MediaDimensions,
  type PdfFirstPage,
  type ProcessedMasterPreview,
  ProcessingFailure,
  parsePdfInfo,
  readWebpDimensions,
  type SourceDownload,
} from "@shutter/executor-runtime";
import { MASTER_PREVIEW_MAX_DIMENSION, type SourceOriginRule } from "@shutter/protocol";

export const PDF_MAX_BYTES = 128 * 1024 * 1024;
export const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1_000;
/** The resolution page one renders at, unless that would exceed the Master Preview box. */
export const PDF_RENDER_DPI = 150;
export { ProcessingFailure, runCommand } from "@shutter/executor-runtime";

export type { CommandRunner };

export interface PdfPreviewRequest {
  locator: string;
  /** Where the source is downloaded. */
  inputPath: string;
  outputPath: string;
}

export interface PdfProcessorDependencies {
  fetch: typeof globalThis.fetch;
  runCommand: CommandRunner;
  allowedSourceOrigins: readonly SourceOriginRule[];
  /** Abandons the attempt: kills poppler and ffmpeg and cancels the download. */
  signal: AbortSignal;
}

/** How page one is rendered: the long edge handed to pdftoppm and the pixel size that should come back. */
export interface PageRender extends MediaDimensions {
  longEdge: number;
}

/**
 * Sizes page one's render from its MediaBox: PDF_RENDER_DPI, capped so the long
 * edge is at most MASTER_PREVIEW_MAX_DIMENSION. pdftoppm is given that long edge
 * (`-scale-to`) rather than a resolution, so it derives the scale from the page
 * box it actually renders and no page size can make it allocate a larger bitmap.
 */
export function planPageRender(page: PdfFirstPage): PageRender {
  const longest = Math.max(page.width, page.height);
  const longEdge = Math.min(
    MASTER_PREVIEW_MAX_DIMENSION,
    Math.ceil((longest * PDF_RENDER_DPI) / 72),
  );
  // pdftoppm lands the long side on `longEdge` and rounds the other side up.
  const side = (points: number) =>
    points === longest ? longEdge : Math.max(1, Math.ceil((points * longEdge) / longest));
  const width = side(page.width);
  const height = side(page.height);
  const turned = page.rotation === 90 || page.rotation === 270;

  return turned ? { longEdge, width: height, height: width } : { longEdge, width, height };
}

/**
 * Renders page one to the Master Preview. The source is downloaded to
 * `inputPath`, pdfinfo reads the page box, pdftoppm renders it straight to the
 * target size as PPM, and its stdout is piped into ffmpeg's WebP encoder; the
 * pair must both exit 0.
 */
export async function processPdfPreview(
  { locator, inputPath, outputPath }: PdfPreviewRequest,
  dependencies: PdfProcessorDependencies,
): Promise<ProcessedMasterPreview> {
  const source: SourceDownload = {
    locator,
    allowedSourceOrigins: dependencies.allowedSourceOrigins,
    fetch: dependencies.fetch,
    maxBytes: PDF_MAX_BYTES,
    tooLargeMessage: "PDF exceeds limit",
    destination: inputPath,
    signal: dependencies.signal,
  };

  await downloadSource(source);

  const render = planPageRender(await readFirstPage(inputPath, dependencies));
  const options: CommandOptions = {
    timeoutMs: ATTEMPT_TIMEOUT_MS,
    signal: dependencies.signal,
    stdinFrom: {
      command: "pdftoppm",
      arguments: [
        "-f",
        "1",
        "-l",
        "1",
        "-singlefile",
        "-scale-to",
        String(render.longEdge),
        inputPath,
      ],
    },
  };

  try {
    await dependencies.runCommand(
      "ffmpeg",
      [
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
        MASTER_PREVIEW_SCALE_FILTER,
        ...MASTER_PREVIEW_ENCODER_OPTIONS,
        "-y",
        outputPath,
      ],
      options,
    );
  } catch (error) {
    if (error instanceof CommandFailure) {
      throw new ProcessingFailure("source_corrupt", "PDF page one could not be rendered");
    }

    throw error;
  }

  const bytes = await readFile(outputPath);
  const { width, height } = readWebpDimensions(bytes);
  // poppler answers a page it cannot rasterize with a tiny placeholder rather than an error.
  if (Math.abs(width - render.width) > 1 || Math.abs(height - render.height) > 1) {
    throw new ProcessingFailure("source_corrupt", "PDF page one rendered at the wrong size");
  }

  return { bytes, width, height };
}

/** Matches poppler's report of a document that needs a user password to open, for any cipher. */
const USER_PASSWORD_REQUIRED = /^Command Line Error: Incorrect password$/m;

async function readFirstPage(
  inputPath: string,
  dependencies: PdfProcessorDependencies,
): Promise<PdfFirstPage> {
  let info: string;
  try {
    info = await dependencies.runCommand("pdfinfo", ["-f", "1", "-l", "1", "-box", inputPath], {
      timeoutMs: 30_000,
      signal: dependencies.signal,
    });
  } catch (error) {
    if (!(error instanceof CommandFailure)) throw error;
    // An owner password alone only restricts permissions and opens normally; this is the user password.
    if (error.exitCode === 1 && USER_PASSWORD_REQUIRED.test(error.stderrTail)) {
      throw new ProcessingFailure("pdf_password_protected", "PDF requires a password to open");
    }

    throw new ProcessingFailure("source_corrupt", "PDF metadata is invalid");
  }

  const page = parsePdfInfo(info);
  if (page === undefined)
    throw new ProcessingFailure("source_corrupt", "PDF has no usable first page");

  return page;
}
