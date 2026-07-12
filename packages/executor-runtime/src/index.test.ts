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

function setup(completeStatus = 204) {
  const requests: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    requests.push(pathname);
    if (pathname.endsWith("/claim")) return Response.json(claim);
    if (pathname.endsWith("/complete")) return new Response(null, { status: completeStatus });
    return new Response(null, { status: 204 });
  });
  const send = vi.fn(async (command: PutObjectCommand | DeleteObjectCommand) =>
    command instanceof PutObjectCommand ? { ETag: "etag" } : {},
  );
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

  it("deletes an uploaded Master Preview after stale completion", async () => {
    const { config, processor, send } = setup(409);
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      PutObjectCommand,
      DeleteObjectCommand,
    ]);
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
