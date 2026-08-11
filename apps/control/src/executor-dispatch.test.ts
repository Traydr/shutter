import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, vi } from "vitest";
import {
  createSerializedExecutorDispatch,
  ExecutorWakeError,
  sendExecutorWake,
} from "./executor-dispatch.js";

describe("executor dispatch", () => {
  it.effect("serializes wakes for one Executor kind", () =>
    Effect.gen(function* () {
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
      const dispatch = yield* createSerializedExecutorDispatch(() => Effect.promise(wake));

      const first = yield* Effect.forkChild(dispatch.dispatch("pdf"));
      yield* Effect.promise(() => vi.waitFor(() => expect(wake).toHaveBeenCalledOnce()));
      const second = yield* Effect.forkChild(dispatch.dispatch("pdf"));

      yield* Effect.promise(() => vi.waitFor(() => expect(finishFirst).toBeTypeOf("function")));
      const callsWhileFirstActive = wake.mock.calls.length;
      finishFirst?.();
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      expect(callsWhileFirstActive).toBe(1);
      expect(wake).toHaveBeenCalledTimes(2);
      expect(maximumActive).toBe(1);
    }),
  );

  it.effect("continues the queue after a failed wake", () =>
    Effect.gen(function* () {
      const wake = vi
        .fn<() => Effect.Effect<void, ExecutorWakeError>>()
        .mockReturnValueOnce(Effect.fail(new ExecutorWakeError({ reason: "request_failed" })))
        .mockReturnValueOnce(Effect.void);
      const dispatch = yield* createSerializedExecutorDispatch(wake);

      const first = yield* Effect.forkChild(Effect.flip(dispatch.dispatch("video")));
      const second = yield* Effect.forkChild(dispatch.dispatch("video"));

      expect(yield* Fiber.join(first)).toMatchObject({ reason: "request_failed" });
      expect(yield* Fiber.join(second)).toBeUndefined();
      expect(wake).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("does not serialize different Executor kinds together", () =>
    Effect.gen(function* () {
      let active = 0;
      let maximumActive = 0;
      const wake = vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
      });
      const dispatch = yield* createSerializedExecutorDispatch(() => Effect.promise(wake));

      yield* Effect.all([dispatch.dispatch("video"), dispatch.dispatch("pdf")], {
        concurrency: "unbounded",
      });

      expect(maximumActive).toBe(2);
    }),
  );

  it.effect("rejects a busy response instead of treating it as a completed wake", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async () => Response.json({ result: "busy" }, { status: 202 }));

      const error = yield* Effect.flip(
        sendExecutorWake({
          baseUrl: "http://executor.test",
          fetch,
          timeoutMs: 1_000,
          token: "x".repeat(32),
        }),
      );
      expect(error).toMatchObject({ reason: "unexpected_status", status: 202 });
    }),
  );

  it.effect("retries only a cold-start 502", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 502 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const wake = yield* Effect.forkChild(
        sendExecutorWake({
          baseUrl: "http://executor.test",
          fetch,
          timeoutMs: 1_000,
          token: "x".repeat(32),
        }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("200 millis");
      yield* Fiber.join(wake);
      expect(fetch).toHaveBeenCalledTimes(2);
    }),
  );
});
