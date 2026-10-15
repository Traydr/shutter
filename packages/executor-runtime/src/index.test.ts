import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { OperationalEvent } from "@shutter/protocol";
import { EXECUTOR_CONFLICT_FIXTURE, EXECUTOR_WAKE_FIXTURE } from "@shutter/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTEMPT_DEADLINE_MS,
  createExecutor,
  type ExecutorConfig,
  type ExecutorProcessor,
  HEARTBEAT_INTERVAL_MS,
  type ProcessedMasterPreview,
  type ProcessInput,
  runExecutorOnce,
} from "./index.js";

const claim = {
  spaceId: "example-private",
  sourceId: "source-1",
  kind: "video",
  locator: "https://example.test/source.mp4",
  outputKey: "masters/source-1.webp",
  processingToken: "processing-token",
  executionCycle: 0,
  attemptNumber: 1,
  allowedSourceOrigins: [{ origin: "https://example.test" }],
};

const PREVIEW: ProcessedMasterPreview = { bytes: new Uint8Array([1]), width: 1920, height: 1080 };

function setup(options?: {
  claimResponse?: () => Response;
  completeStatus?: number;
  completeThrows?: boolean;
  failStatus?: number;
  failThrows?: boolean;
  heartbeat?: () => Response;
}) {
  const {
    claimResponse = () => Response.json(claim),
    completeStatus = 204,
    completeThrows = false,
    failStatus = 204,
    failThrows = false,
    heartbeat = () => new Response(null, { status: 204 }),
  } = options ?? {};
  const requests: string[] = [];
  const bodies: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    requests.push(pathname);
    if (init?.body !== undefined) bodies.push(String(init.body));
    if (pathname.endsWith("/claim")) return claimResponse();
    if (pathname.endsWith("/heartbeat")) return heartbeat();
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
    return {};
  });
  const config: ExecutorConfig = {
    controlBaseUrl: "https://control.test",
    roleToken: "r".repeat(32),
    bucket: "media",
    s3: { send },
    fetch,
  };
  const processor: ExecutorProcessor = {
    kind: "video",
    process: vi.fn(async () => PREVIEW),
    failure: () => ({ retryable: true }),
  };
  return { config, processor, requests, bodies, send };
}

/** A processor that runs until the test finishes it, and stops when its signal aborts. */
function heldProcessor(processor: ExecutorProcessor) {
  let finish: (() => void) | undefined;
  let input: ProcessInput | undefined;
  processor.process = vi.fn(
    (received: ProcessInput) =>
      new Promise<ProcessedMasterPreview>((resolve, reject) => {
        input = received;
        finish = () => resolve(PREVIEW);
        received.signal.addEventListener("abort", () => reject(received.signal.reason), {
          once: true,
        });
      }),
  );

  return {
    finish: () => finish?.(),
    signal: () => input?.signal,
  };
}

/** The operational events the work cycle wrote, by name and the fields a test cares about. */
function capturedEvents() {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);

  return () =>
    error.mock.calls.map(([line]) => {
      const event: OperationalEvent = JSON.parse(line);

      return {
        event: event.event,
        failureCode: event.failureCode,
        httpStatusCode: event.httpStatusCode,
        errorType: event.errorType,
      };
    });
}

describe("Executor work cycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("claims, processes, uploads, and completes through one interface", async () => {
    const { config, processor, requests, send } = setup();
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(processor.process).toHaveBeenCalledOnce();
    expect(processor.process).toHaveBeenCalledWith({
      locator: claim.locator,
      directory: expect.any(String),
      fetch: config.fetch,
      allowedSourceOrigins: claim.allowedSourceOrigins,
      signal: expect.any(AbortSignal),
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(requests).toEqual([
      "/internal/v1/executors/video/claim",
      "/internal/v1/executors/video/jobs/example-private/source-1/complete",
    ]);
  });

  it("answers idle when there is nothing to claim", async () => {
    const { config, processor } = setup({
      claimResponse: () => new Response(null, { status: 204 }),
    });
    await expect(runExecutorOnce(config, processor)).resolves.toBe("idle");
    expect(processor.process).not.toHaveBeenCalled();
  });

  it.each(EXECUTOR_CONFLICT_FIXTURE.claim.codes)(
    "counts a job Control settled as %s while serving the claim as processed",
    async (code) => {
      const { config, processor, requests } = setup({
        claimResponse: () =>
          Response.json({ error: { code } }, { status: EXECUTOR_CONFLICT_FIXTURE.claim.status }),
      });
      await expect(runExecutorOnce(config, processor)).resolves.toBe(
        EXECUTOR_CONFLICT_FIXTURE.claim.result,
      );
      expect(processor.process).not.toHaveBeenCalled();
      expect(requests).toEqual(["/internal/v1/executors/video/claim"]);
    },
  );

  it("fails the invocation when Control cannot serve the claim", async () => {
    const { config, processor } = setup({
      claimResponse: () =>
        Response.json({ error: { code: "service_unavailable" } }, { status: 503 }),
    });
    await expect(runExecutorOnce(config, processor)).rejects.toThrow(
      "Control claim failed with 503",
    );
  });

  it("conditionally deletes this attempt's Master Preview after a lost complete", async () => {
    const { config, processor, send } = setup({ completeStatus: 409 });
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      PutObjectCommand,
      DeleteObjectCommand,
    ]);
    const [deletion] = send.mock.calls[1] ?? [];
    expect(deletion).toBeInstanceOf(DeleteObjectCommand);
    expect(deletion?.input).toMatchObject({ Key: "masters/source-1.webp", IfMatch: '"etag-1"' });
  });

  it("does not delete when fail reports the attempt is already gone", async () => {
    const { config, processor, requests, send } = setup({
      completeThrows: true,
      failStatus: 409,
    });
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([PutObjectCommand]);
    expect(requests.at(-1)).toBe("/internal/v1/executors/video/jobs/example-private/source-1/fail");
  });

  it("reports processing failure without uploading", async () => {
    const { config, processor, requests, send } = setup();
    processor.process = vi.fn(async () => {
      throw new Error("corrupt");
    });
    await expect(runExecutorOnce(config, processor)).resolves.toBe("processed");
    expect(send).not.toHaveBeenCalled();
    expect(requests.at(-1)).toBe("/internal/v1/executors/video/jobs/example-private/source-1/fail");
  });

  it("logs a heartbeat Control could not answer and keeps working", async () => {
    vi.useFakeTimers();
    const events = capturedEvents();
    const answers: (() => Response)[] = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response(null, { status: 503 }),
    ];
    const { config, processor, requests } = setup({
      heartbeat: () => (answers.shift() ?? (() => new Response(null, { status: 204 })))(),
    });
    const held = heldProcessor(processor);

    const result = runExecutorOnce(config, processor);
    await vi.waitFor(() => expect(held.signal()).toBeDefined());
    await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_INTERVAL_MS);
    expect(held.signal()?.aborted).toBe(false);
    held.finish();

    await expect(result).resolves.toBe("processed");
    expect(requests.filter((path) => path.endsWith("/heartbeat"))).toHaveLength(2);
    expect(requests.at(-1)).toBe(
      "/internal/v1/executors/video/jobs/example-private/source-1/complete",
    );
    await vi.waitFor(() => expect(events()).toHaveLength(2));
    expect(events()).toEqual([
      {
        event: "executor.heartbeat_failed",
        failureCode: "service_unavailable",
        httpStatusCode: undefined,
        errorType: "TypeError",
      },
      {
        event: "executor.heartbeat_failed",
        failureCode: "service_unavailable",
        httpStatusCode: 503,
        errorType: undefined,
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the attempt when a heartbeat finds it stale", async () => {
    vi.useFakeTimers();
    const events = capturedEvents();
    const { config, processor, requests, send } = setup({
      heartbeat: () =>
        Response.json(
          { error: { code: EXECUTOR_CONFLICT_FIXTURE.heartbeat.code } },
          { status: EXECUTOR_CONFLICT_FIXTURE.heartbeat.status },
        ),
    });
    const held = heldProcessor(processor);

    const result = runExecutorOnce(config, processor);
    await vi.waitFor(() => expect(held.signal()).toBeDefined());
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    await expect(result).resolves.toBe(EXECUTOR_CONFLICT_FIXTURE.heartbeat.result);
    expect(held.signal()?.aborted).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(requests.at(-1)).toBe(
      "/internal/v1/executors/video/jobs/example-private/source-1/heartbeat",
    );
    expect(events()).toEqual([
      {
        event: "executor.failed",
        failureCode: "stale_attempt",
        httpStatusCode: undefined,
        errorType: undefined,
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the whole attempt at its deadline, even for work that ignores the signal", async () => {
    vi.useFakeTimers();
    capturedEvents();
    const { config, processor, requests, bodies, send } = setup();
    let signal: AbortSignal | undefined;
    processor.process = vi.fn((input: ProcessInput) => {
      signal = input.signal;
      return new Promise<ProcessedMasterPreview>(() => {});
    });
    processor.failure = () => ({ retryable: false, code: "source_corrupt" });

    const result = runExecutorOnce(config, processor);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(ATTEMPT_DEADLINE_MS);

    await expect(result).resolves.toBe("processed");
    expect(signal?.aborted).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(requests.at(-1)).toBe("/internal/v1/executors/video/jobs/example-private/source-1/fail");
    expect(bodies.filter((body) => body.includes("retryable"))).toEqual([
      JSON.stringify({ processingToken: claim.processingToken, retryable: true }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Executor wake", () => {
  it("answers each invocation result with its pinned reply", async () => {
    for (const result of ["processed", "idle"] as const) {
      const { config } = setup();
      const { app } = createExecutor("video", config, async () => result);

      const reply = await app.request(`http://executor.test${EXECUTOR_WAKE_FIXTURE.route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.roleToken}` },
      });

      expect(reply.status).toBe(200);
      await expect(reply.text()).resolves.toBe(EXECUTOR_WAKE_FIXTURE.replies[result]);
    }
  });
});
