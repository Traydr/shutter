import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  emitOperationalEvent,
  type JobFailureCode,
  operationalEvent,
  type RenditionKind,
  type SourceOriginRule,
} from "@shutter/protocol";
import { getSpacePolicy } from "@shutter/space-config";
import { Hono } from "hono";

interface Claim {
  spaceId: string;
  sourceId: string;
  kind: RenditionKind;
  locator: string;
  outputKey: string;
  processingToken: string;
  executionCycle: number;
  attemptNumber: number;
}

export interface ExecutorConfig {
  controlBaseUrl: string;
  roleToken: string;
  bucket: string;
  s3: S3Client;
  fetch: typeof globalThis.fetch;
}

export interface ProcessedMasterPreview {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface ExecutorProcessor {
  kind: RenditionKind;
  process(
    locator: string,
    directory: string,
    fetch: typeof globalThis.fetch,
    allowedSourceOrigins: readonly SourceOriginRule[],
  ): Promise<ProcessedMasterPreview>;
  failure(error: unknown): { retryable: boolean; code?: JobFailureCode };
}

async function control(config: ExecutorConfig, path: string, init: RequestInit): Promise<Response> {
  return config.fetch(new URL(path, config.controlBaseUrl), {
    ...init,
    headers: { authorization: `Bearer ${config.roleToken}`, ...init.headers },
  });
}

export async function runExecutorOnce(
  config: ExecutorConfig,
  processor: ExecutorProcessor,
): Promise<"idle" | "processed"> {
  const claimed = await control(config, `/internal/v1/executors/${processor.kind}/claim`, {
    method: "POST",
  });
  if (claimed.status === 204) return "idle";
  if (!claimed.ok) throw new Error(`Control claim failed with ${claimed.status}`);
  const claim = (await claimed.json()) as Claim;
  if (claim.kind !== processor.kind) throw new Error("Control returned the wrong Rendition kind");
  const startedAt = Date.now();
  emitOperationalEvent(
    "info",
    await operationalEvent({
      event: "executor.claimed",
      spaceId: claim.spaceId,
      sourceId: claim.sourceId,
      processingToken: claim.processingToken,
      fields: {
        kind: claim.kind,
        executionCycle: claim.executionCycle,
        attemptNumber: claim.attemptNumber,
        outcome: "accepted",
      },
    }),
  );
  const directory = await mkdtemp(join(tmpdir(), `shutter-${processor.kind}-`));
  let uploaded = false;
  let objectEtag: string | undefined;
  const transition = `/internal/v1/executors/${processor.kind}/jobs/${encodeURIComponent(claim.spaceId)}/${encodeURIComponent(claim.sourceId)}`;
  const policy = getSpacePolicy(claim.spaceId);
  if (policy === undefined) throw new Error(`Unknown Shutter Space ${claim.spaceId}`);
  const heartbeat = setInterval(() => {
    void control(config, `${transition}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ processingToken: claim.processingToken }),
    });
  }, 60_000);
  try {
    const preview = await processor.process(
      claim.locator,
      directory,
      config.fetch,
      policy.allowedSourceOrigins,
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
    objectEtag = put.ETag;
    const completed = await control(config, `${transition}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        processingToken: claim.processingToken,
        masterKey: claim.outputKey,
        width: preview.width,
        height: preview.height,
        format: "webp",
        objectEtag: objectEtag ?? "",
      }),
    });
    if (!completed.ok) {
      if (completed.status === 409) {
        await deleteUploadedAttempt(config, claim.outputKey, objectEtag);
        uploaded = false;
        await emit("executor.stale_completion", "error", claim, startedAt, "stale_attempt");
        return "processed";
      }
      throw new Error(`Control completion failed with ${completed.status}`);
    }
    await emit("executor.completed", "info", claim, startedAt);
    return "processed";
  } catch (error) {
    const failure = processor.failure(error);
    await emit("executor.failed", "error", claim, startedAt, failure.code);
    let failed: Response;
    try {
      failed = await control(config, `${transition}/fail`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ processingToken: claim.processingToken, ...failure }),
      });
    } catch {
      // Prefer an orphaned object over deleting a master Control may already own.
      return "processed";
    }
    if (uploaded && failed.status === 204)
      await deleteUploadedAttempt(config, claim.outputKey, objectEtag);
    return "processed";
  } finally {
    clearInterval(heartbeat);
    await rm(directory, { recursive: true, force: true });
  }
}

async function deleteUploadedAttempt(
  config: ExecutorConfig,
  key: string,
  objectEtag: string | undefined,
): Promise<void> {
  if (objectEtag === undefined || objectEtag === "") return;
  try {
    await config.s3.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
        IfMatch: objectEtag,
      }),
    );
  } catch {
    // Precondition failure means a newer object owns the key; leave it alone.
  }
}

async function emit(
  event: "executor.completed" | "executor.failed" | "executor.stale_completion",
  level: "info" | "error",
  claim: Claim,
  startedAt: number,
  failureCode?: JobFailureCode | "stale_attempt",
) {
  emitOperationalEvent(
    level,
    await operationalEvent({
      event,
      spaceId: claim.spaceId,
      sourceId: claim.sourceId,
      processingToken: claim.processingToken,
      fields: {
        kind: claim.kind,
        executionCycle: claim.executionCycle,
        attemptNumber: claim.attemptNumber,
        durationMs: Date.now() - startedAt,
        outcome: event === "executor.completed" ? "ready" : "failed",
        ...(failureCode === undefined ? {} : { failureCode }),
      },
    }),
  );
}

export type ExecutorRunner = (config: ExecutorConfig) => Promise<"idle" | "processed">;

function credentialDigest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorizedWake(header: string | undefined, expectedToken: string): boolean {
  if (expectedToken.length < 32 || header === undefined || !header.startsWith("Bearer "))
    return false;
  return timingSafeEqual(
    credentialDigest(header.slice("Bearer ".length)),
    credentialDigest(expectedToken),
  );
}

export function createExecutorApp(
  kind: RenditionKind,
  config?: ExecutorConfig,
  run?: ExecutorRunner,
): Hono {
  const app = new Hono();
  let running = false;
  app.get("/healthz", (context) => context.json({ ok: true, service: `executor-${kind}` }));
  app.post("/internal/v1/run-once", async (context) => {
    if (
      config === undefined ||
      run === undefined ||
      !authorizedWake(context.req.header("authorization"), config.roleToken)
    )
      return context.json({ error: { code: "unauthorized" } }, 401);
    if (running) return context.json({ result: "busy" }, 202);
    running = true;
    try {
      return context.json({ result: await run(config) });
    } catch {
      emitOperationalEvent("error", {
        event: "executor.failed",
        kind,
        outcome: "failed",
        failureCode: "service_unavailable",
      });
      return context.json({ error: { code: "service_unavailable" } }, 503);
    } finally {
      running = false;
    }
  });
  return app;
}
