import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  createSerializedExecutorDispatch,
  ExecutorWakeError,
  sendExecutorWake,
} from "./executor-dispatch.js";

describe("executor dispatch", () => {
  it("serializes wakes for one Executor kind", async () => {
    let finishFirst: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const wake = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (wake.mock.calls.length === 1) {
          await new Promise<void>((resolve) => {
            finishFirst = resolve;
          });
        }
      } finally {
        active -= 1;
      }
    });
    const dispatch = await Effect.runPromise(
      createSerializedExecutorDispatch(() => Effect.promise(wake)),
    );

    const first = Effect.runPromise(dispatch.dispatch("pdf"));
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
    const second = Effect.runPromise(dispatch.dispatch("pdf"));

    await vi.waitFor(() => expect(finishFirst).toBeTypeOf("function"));
    const callsWhileFirstActive = wake.mock.calls.length;
    finishFirst?.();
    await Promise.all([first, second]);

    expect(callsWhileFirstActive).toBe(1);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
  });

  it("continues the queue after a failed wake", async () => {
    const wake = vi
      .fn<() => Effect.Effect<void, ExecutorWakeError>>()
      .mockReturnValueOnce(Effect.fail(new ExecutorWakeError({ reason: "request_failed" })))
      .mockReturnValueOnce(Effect.void);
    const dispatch = await Effect.runPromise(createSerializedExecutorDispatch(wake));

    const first = Effect.runPromise(dispatch.dispatch("video"));
    const second = Effect.runPromise(dispatch.dispatch("video"));

    await expect(first).rejects.toMatchObject({ reason: "request_failed" });
    await expect(second).resolves.toBeUndefined();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("does not serialize different Executor kinds together", async () => {
    let active = 0;
    let maximumActive = 0;
    const wake = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
    });
    const dispatch = await Effect.runPromise(
      createSerializedExecutorDispatch(() => Effect.promise(wake)),
    );

    await Promise.all([
      Effect.runPromise(dispatch.dispatch("video")),
      Effect.runPromise(dispatch.dispatch("pdf")),
    ]);

    expect(maximumActive).toBe(2);
  });

  it("rejects a busy response instead of treating it as a completed wake", async () => {
    const fetch = vi.fn(async () => Response.json({ result: "busy" }, { status: 202 }));

    await expect(
      Effect.runPromise(
        sendExecutorWake({
          baseUrl: "http://executor.test",
          fetch,
          timeoutMs: 1_000,
          token: "x".repeat(32),
        }),
      ),
    ).rejects.toMatchObject({ reason: "unexpected_status", status: 202 });
  });

  it("retries only a cold-start 502", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await Effect.runPromise(
      sendExecutorWake({
        baseUrl: "http://executor.test",
        fetch,
        timeoutMs: 1_000,
        token: "x".repeat(32),
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
