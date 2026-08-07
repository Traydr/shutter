import { DeleteObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, vi } from "vitest";
import {
  type ExecutorConfig,
  type ExecutorProcessor,
  loadExecutorConfig,
  runExecutorOnce,
} from "./index.js";

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
  failNever?: boolean;
}) {
  const {
    completeStatus = 204,
    completeThrows = false,
    failStatus = 204,
    failThrows = false,
    failNever = false,
  } = options ?? {};
  const requests: string[] = [];
  const failureBodies: unknown[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    requests.push(pathname);
    if (pathname.endsWith("/claim")) return Response.json(claim);
    if (pathname.endsWith("/complete")) {
      if (completeThrows) throw new TypeError("network down");
      return new Response(null, { status: completeStatus });
    }
    if (pathname.endsWith("/fail")) {
      failureBodies.push(JSON.parse(String(init?.body)));
      if (failThrows) throw new TypeError("fail unreachable");
      if (failNever) return await new Promise<Response>(() => {});
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
    bucket: "renditions",
    s3: { send } as unknown as S3Client,
    fetch,
  };
  const processor: ExecutorProcessor = {
    kind: "video",
    process: vi.fn(() => Effect.succeed({ bytes: new Uint8Array([1]), width: 1920, height: 1080 })),
    failure: () => ({ retryable: true }),
  };
  return { config, failureBodies, processor, requests, send };
}

describe("Executor work cycle", () => {
  it.effect("claims, processes, uploads, and completes through one interface", () =>
    Effect.gen(function* () {
      const { config, processor, requests, send } = setup();
      expect(yield* runExecutorOnce(config, processor)).toBe("processed");
      expect(processor.process).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
      expect(requests).toEqual([
        "/internal/v1/executors/video/claim",
        "/internal/v1/executors/video/jobs/pane-view/source-1/complete",
      ]);
    }),
  );

  it.effect("conditionally deletes this attempt's Master Preview after a lost complete", () =>
    Effect.gen(function* () {
      const { config, processor, send } = setup({ completeStatus: 409 });
      expect(yield* runExecutorOnce(config, processor)).toBe("processed");
      expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
        PutObjectCommand,
        DeleteObjectCommand,
      ]);
      expect((send.mock.calls[1]?.[0] as DeleteObjectCommand).input).toMatchObject({
        Key: "masters/source-1.webp",
        IfMatch: '"etag-1"',
      });
    }),
  );

  it.effect("does not delete when fail reports the attempt is already gone", () =>
    Effect.gen(function* () {
      const { config, processor, requests, send } = setup({
        completeThrows: true,
        failStatus: 409,
      });
      expect(yield* runExecutorOnce(config, processor)).toBe("processed");
      expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([PutObjectCommand]);
      expect(requests.at(-1)).toBe("/internal/v1/executors/video/jobs/pane-view/source-1/fail");
    }),
  );

  it.effect("conditionally deletes an uploaded preview after Control accepts fail", () =>
    Effect.gen(function* () {
      const { config, processor, send } = setup({ completeThrows: true });

      expect(yield* runExecutorOnce(config, processor)).toBe("processed");

      expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
        PutObjectCommand,
        DeleteObjectCommand,
      ]);
      expect((send.mock.calls[1]?.[0] as DeleteObjectCommand).input).toMatchObject({
        Key: "masters/source-1.webp",
        IfMatch: '"etag-1"',
      });
    }),
  );

  it.effect("leaves an uploaded preview orphaned when the fail call throws", () =>
    Effect.gen(function* () {
      const { config, processor, send } = setup({ completeThrows: true, failThrows: true });

      expect(yield* runExecutorOnce(config, processor)).toBe("processed");

      expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([PutObjectCommand]);
    }),
  );

  it.effect("reports processing failure without uploading", () =>
    Effect.gen(function* () {
      const { config, processor, requests, send } = setup();
      processor.process = vi.fn(() => Effect.fail(new Error("corrupt")));
      expect(yield* runExecutorOnce(config, processor)).toBe("processed");
      expect(send).not.toHaveBeenCalled();
      expect(requests.at(-1)).toBe("/internal/v1/executors/video/jobs/pane-view/source-1/fail");
    }),
  );

  it.effect("keeps unexpected processor throws as defects", () =>
    Effect.gen(function* () {
      const { config, processor, requests, send } = setup();
      processor.process = vi.fn(() => Effect.die(new Error("processor invariant")));

      const exit = yield* Effect.exit(runExecutorOnce(config, processor));
      expect(Exit.isFailure(exit)).toBe(true);

      expect(send).not.toHaveBeenCalled();
      expect(requests).toEqual(["/internal/v1/executors/video/claim"]);
    }),
  );

  it.effect("turns an unexpected processor typed failure into a defect", () =>
    Effect.gen(function* () {
      const { config, processor, requests, send } = setup();
      processor.process = vi.fn(() => Effect.fail(new Error("unmodeled processor failure")));

      const exit = yield* Effect.exit(runExecutorOnce(config, processor));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.hasFails(exit.cause)).toBe(false);
      }
      expect(send).not.toHaveBeenCalled();
      expect(requests).toEqual(["/internal/v1/executors/video/claim"]);
    }),
  );

  it.effect("reports a ten-minute processing timeout as a retryable failure", () =>
    Effect.gen(function* () {
      const { config, failureBodies, processor, requests, send } = setup();
      processor.process = vi.fn(() => Effect.never);

      const fiber = yield* Effect.forkChild(runExecutorOnce(config, processor));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(processor.process).toHaveBeenCalledOnce()),
      );
      yield* TestClock.adjust("10 minutes");

      expect(yield* Fiber.join(fiber)).toBe("processed");
      expect(send).not.toHaveBeenCalled();
      expect(requests.at(-1)).toBe("/internal/v1/executors/video/jobs/pane-view/source-1/fail");
      expect(failureBodies).toEqual([{ processingToken: "processing-token", retryable: true }]);
    }),
  );

  it.effect("keeps heartbeating while a timed-out attempt reports its failure", () =>
    Effect.gen(function* () {
      const { config, processor, requests } = setup({ failNever: true });
      processor.process = vi.fn(() => Effect.never);
      const fiber = yield* Effect.forkChild(runExecutorOnce(config, processor));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(processor.process).toHaveBeenCalledOnce()),
      );

      yield* TestClock.adjust("10 minutes");
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(requests.some((path) => path.endsWith("/fail"))).toBe(true)),
      );
      const heartbeatsAtTimeout = requests.filter((path) => path.endsWith("/heartbeat")).length;
      yield* TestClock.adjust("1 minute");

      expect(requests.filter((path) => path.endsWith("/heartbeat"))).toHaveLength(
        heartbeatsAtTimeout + 1,
      );
      yield* Fiber.interrupt(fiber);
    }),
  );
});

describe("Executor configuration", () => {
  it.effect("stays unconfigured when required environment values are missing or empty", () =>
    Effect.gen(function* () {
      expect(yield* loadExecutorConfig({})).toBeUndefined();
      expect(
        yield* loadExecutorConfig({
          CONTROL_BASE_URL: "https://control.test",
          EXECUTOR_ROLE_TOKEN: "",
          S3_ENDPOINT: "https://s3.test",
          S3_ACCESS_KEY_ID: "access",
          S3_SECRET_ACCESS_KEY: "secret",
          S3_BUCKET: "renditions",
        }),
      ).toBeUndefined();
    }),
  );
});
