import { DeleteObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { type ExecutorConfig, type ExecutorProcessor, runExecutorOnce } from "./index.js";

const claim = {
  spaceId: "pane-view",
  sourceId: "source-1",
  kind: "video",
  locator: "https://example.test/source.mp4",
  outputKey: "masters/source-1.webp",
  processingToken: "processing-token",
  executionCycle: 0,
  attemptNumber: 1,
};

function setup(options?: {
  completeStatus?: number;
  completeThrows?: boolean;
  failStatus?: number;
  failThrows?: boolean;
  deleteThrows?: boolean;
}) {
  const {
    completeStatus = 204,
    completeThrows = false,
    failStatus = 204,
    failThrows = false,
    deleteThrows = false,
  } = options ?? {};
  const requests: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    requests.push(pathname);
    if (pathname.endsWith("/claim")) return Response.json(claim);
    if (pathname.endsWith("/complete")) {
      if (completeThrows) throw new TypeError("network down");
      return new Response(null, { status: completeStatus });
    }
    if (pathname.endsWith("/fail")) {
      if (failThrows) throw new TypeError("fail unreachable");
      return new Response(null, { status: failStatus });
    }
    return new Response(null, { status: 204 });
  });
  const send = vi.fn(async (command: PutObjectCommand | DeleteObjectCommand) => {
    if (command instanceof PutObjectCommand) return { ETag: '"etag-1"' };
    if (deleteThrows) {
      const error = new Error("PreconditionFailed");
      error.name = "PreconditionFailed";
      throw error;
    }
    return {};
  });
  const config: ExecutorConfig = {
    controlBaseUrl: "https://control.test",
    roleToken: "r".repeat(32),
    bucket: "renditions",
    s3: { send } as unknown as S3Client,
    fetch,
  };
  const processor: ExecutorProcessor = {
    kind: "video",
    process: vi.fn(async () => ({ bytes: new Uint8Array([1]), width: 1920, height: 1080 })),
    failure: () => ({ retryable: true }),
  };
  return { config, processor, requests, send };
}

describe("Executor work cycle", () => {
  it("claims, processes, uploads, and completes through one interface", async () => {
    const { config, processor, requests, send } = setup();
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(processor.process).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(requests).toEqual([
      "/internal/v1/executors/video/claim",
      "/internal/v1/executors/video/jobs/pane-view/source-1/complete",
    ]);
  });

  it("conditionally deletes this attempt's Master Preview after stale completion", async () => {
    const { config, processor, send } = setup({ completeStatus: 409 });
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      PutObjectCommand,
      DeleteObjectCommand,
    ]);
    const deleted = send.mock.calls[1]?.[0] as DeleteObjectCommand;
    expect(deleted.input).toMatchObject({
      Bucket: "renditions",
      Key: "masters/source-1.webp",
      IfMatch: '"etag-1"',
    });
  });

  it("leaves the Master Preview when conditional delete finds a newer etag", async () => {
    const { config, processor, send } = setup({ completeStatus: 409, deleteThrows: true });
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      PutObjectCommand,
      DeleteObjectCommand,
    ]);
  });

  it("does not delete after a lost complete when fail reports the attempt is already gone", async () => {
    const { config, processor, requests, send } = setup({
      completeThrows: true,
      failStatus: 409,
    });
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([PutObjectCommand]);
    expect(requests.at(-1)).toBe("/internal/v1/executors/video/jobs/pane-view/source-1/fail");
  });

  it("conditionally deletes after fail accepts ownership of a post-upload error", async () => {
    const { config, processor, send } = setup({ completeStatus: 500 });
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      PutObjectCommand,
      DeleteObjectCommand,
    ]);
    const deleted = send.mock.calls[1]?.[0] as DeleteObjectCommand;
    expect(deleted.input.IfMatch).toBe('"etag-1"');
  });

  it("skips delete when fail itself cannot be reached after upload", async () => {
    const { config, processor, send } = setup({
      completeThrows: true,
      failThrows: true,
    });
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([PutObjectCommand]);
  });

  it("reports processing failure without uploading", async () => {
    const { config, processor, requests, send } = setup();
    processor.process = vi.fn(async () => {
      throw new Error("corrupt");
    });
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(send).not.toHaveBeenCalled();
    expect(requests.at(-1)).toBe("/internal/v1/executors/video/jobs/pane-view/source-1/fail");
  });
});
