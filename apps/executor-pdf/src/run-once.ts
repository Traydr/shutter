import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { ProcessingFailure, processPdfPreview, runCommand } from "./processor.js";

interface Claim {
  spaceId: string;
  sourceId: string;
  kind: "pdf";
  locator: string;
  outputKey: string;
  processingToken: string;
}
export interface PdfExecutorConfig {
  controlBaseUrl: string;
  roleToken: string;
  bucket: string;
  s3: S3Client;
  fetch: typeof globalThis.fetch;
}
async function control(
  config: PdfExecutorConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  return config.fetch(new URL(path, config.controlBaseUrl), {
    ...init,
    headers: { authorization: `Bearer ${config.roleToken}`, ...init.headers },
  });
}

export async function runPdfOnce(config: PdfExecutorConfig): Promise<"idle" | "processed"> {
  const claimed = await control(config, "/internal/v1/executors/pdf/claim", { method: "POST" });
  if (claimed.status === 204) return "idle";
  if (!claimed.ok) throw new Error(`Control claim failed with ${claimed.status}`);
  const claim = (await claimed.json()) as Claim;
  const directory = await mkdtemp(join(tmpdir(), "shutter-pdf-"));
  let uploaded = false;
  const transition = `/internal/v1/executors/pdf/jobs/${encodeURIComponent(claim.spaceId)}/${encodeURIComponent(claim.sourceId)}`;
  const heartbeat = setInterval(() => {
    void control(config, `${transition}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ processingToken: claim.processingToken }),
    });
  }, 60_000);
  try {
    const preview = await processPdfPreview(
      claim.locator,
      join(directory, "source.pdf"),
      join(directory, "page"),
      join(directory, "preview.webp"),
      { fetch: config.fetch, runCommand },
    );
    const put = await config.s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: claim.outputKey,
        Body: preview.bytes,
        ContentType: "image/webp",
      }),
    );
    uploaded = true;
    const completed = await control(config, `${transition}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        processingToken: claim.processingToken,
        masterKey: claim.outputKey,
        width: preview.width,
        height: preview.height,
        format: "webp",
        objectEtag: put.ETag ?? "",
      }),
    });
    if (!completed.ok) {
      await config.s3.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: claim.outputKey }),
      );
      uploaded = false;
      if (completed.status !== 409)
        throw new Error(`Control completion failed with ${completed.status}`);
    }
    return "processed";
  } catch (error) {
    if (uploaded)
      await config.s3.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: claim.outputKey }),
      );
    const failure =
      error instanceof ProcessingFailure
        ? { retryable: error.retryable, code: error.code }
        : { retryable: true };
    await control(config, `${transition}/fail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ processingToken: claim.processingToken, ...failure }),
    });
    return "processed";
  } finally {
    clearInterval(heartbeat);
    await rm(directory, { recursive: true, force: true });
  }
}
