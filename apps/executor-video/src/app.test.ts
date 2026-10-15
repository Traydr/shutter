import type { S3Client } from "@aws-sdk/client-s3";
import type { ExecutorInvocationResult } from "@shutter/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoExecutor } from "./app.js";

const TOKEN = "v".repeat(32);
const WAKE_URL = "http://shutter.test/internal/v1/run-once";
const WAKE = { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } };

function config() {
  return {
    controlBaseUrl: "http://control.test",
    roleToken: TOKEN,
    bucket: "test",
    s3: { send: vi.fn<S3Client["send"]>() },
    fetch: vi.fn<typeof fetch>(),
  };
}

/** A runner whose invocations the test settles one at a time, in order. */
function heldRunner() {
  const settles: ((result: ExecutorInvocationResult | Error) => void)[] = [];
  const run = vi.fn(
    () =>
      new Promise<ExecutorInvocationResult>((resolve, reject) => {
        settles.push((result) => (result instanceof Error ? reject(result) : resolve(result)));
      }),
  );
  const settle = async (result: ExecutorInvocationResult | Error) => {
    await vi.waitFor(() => expect(settles.length).toBeGreaterThan(0));
    settles.shift()?.(result);
  };

  return { run, settle };
}

describe("video executor app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("authenticates a wake with the executor role token", async () => {
    const run = vi.fn(async () => "idle" as const);
    const { app } = createVideoExecutor(config(), run);

    const unauthorized = await app.request(WAKE_URL, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    expect(unauthorized.status).toBe(401);

    const accepted = await app.request(WAKE_URL, WAKE);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ result: "idle" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("answers a wake during an invocation that processed a job with that result", async () => {
    const { run, settle } = heldRunner();
    const { app } = createVideoExecutor(config(), run);

    const first = app.request(WAKE_URL, WAKE);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const joined = app.request(WAKE_URL, WAKE);
    await settle("processed");

    await expect((await first).json()).resolves.toEqual({ result: "processed" });
    await expect((await joined).json()).resolves.toEqual({ result: "processed" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs its own invocation after one in flight found nothing, one at a time", async () => {
    const { run, settle } = heldRunner();
    const { app } = createVideoExecutor(config(), run);

    const first = app.request(WAKE_URL, WAKE);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const second = app.request(WAKE_URL, WAKE);
    await settle("idle");
    await expect((await first).json()).resolves.toEqual({ result: "idle" });

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await settle("processed");
    await expect((await second).json()).resolves.toEqual({ result: "processed" });
  });

  it("answers 503 when its invocation fails, and the next wake runs a fresh one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { run, settle } = heldRunner();
    const { app } = createVideoExecutor(config(), run);

    const failing = app.request(WAKE_URL, WAKE);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const waiting = app.request(WAKE_URL, WAKE);
    await settle(new Error("claim failed"));
    const failed = await failing;
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ error: { code: "service_unavailable" } });

    await settle("idle");
    await expect((await waiting).json()).resolves.toEqual({ result: "idle" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("claims once on boot, and a wake that arrives meanwhile joins that invocation", async () => {
    const { run, settle } = heldRunner();
    const executor = createVideoExecutor(config(), run);

    const booted = executor.boot();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const wake = executor.app.request(WAKE_URL, WAKE);
    await settle("processed");

    await expect(booted).resolves.toBeUndefined();
    await expect((await wake).json()).resolves.toEqual({ result: "processed" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("survives a boot invocation that cannot reach Control", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = vi.fn(async (): Promise<ExecutorInvocationResult> => {
      throw new TypeError("fetch failed");
    });

    await expect(createVideoExecutor(config(), run).boot()).resolves.toBeUndefined();
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      {
        level: "error",
        event: "executor.failed",
        kind: "video",
        outcome: "failed",
        failureCode: "service_unavailable",
      },
    ]);
  });

  it("does not claim on boot without configuration", async () => {
    const run = vi.fn(async () => "idle" as const);

    await createVideoExecutor(undefined, run).boot();

    expect(run).not.toHaveBeenCalled();
  });
});
