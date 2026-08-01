import { describe, expect, it, vi } from "vitest";
import { createSerializedExecutorDispatch, sendExecutorWake } from "./executor-dispatch.js";

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
    const dispatch = createSerializedExecutorDispatch(wake);

    const first = dispatch("pdf");
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
    const second = dispatch("pdf");

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
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce();
    const dispatch = createSerializedExecutorDispatch(wake);

    const first = dispatch("video");
    const second = dispatch("video");

    await expect(first).rejects.toThrow("unavailable");
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
    const dispatch = createSerializedExecutorDispatch(wake);

    await Promise.all([dispatch("video"), dispatch("pdf")]);

    expect(maximumActive).toBe(2);
  });

  it("rejects a busy response instead of treating it as a completed wake", async () => {
    const fetch = vi.fn(async () => Response.json({ result: "busy" }, { status: 202 }));

    await expect(
      sendExecutorWake({
        baseUrl: "http://executor.test",
        fetch,
        timeoutMs: 1_000,
        token: "x".repeat(32),
      }),
    ).rejects.toThrow("executor wake did not complete (202)");
  });
});
