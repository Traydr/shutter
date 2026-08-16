import { describe, expect, it, vi } from "vitest";
import type { ControlLogger } from "./logging.js";
import { createControlShutdown } from "./shutdown.js";

describe("Control process lifecycle", () => {
  it("stops work and HTTP before flushing logs exactly once, including on drain timeout", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const logger: ControlLogger = {
        emit() {},
        async shutdown() {
          calls.push("logger.shutdown");
        },
      };
      const setExitCode = vi.fn();
      const shutdown = createControlShutdown({
        logger,
        stopRecovery: () => calls.push("recovery.stop"),
        closeServer: () => new Promise<void>(() => {}),
        closeRuntime: async () => {
          calls.push("runtime.close");
        },
        setExitCode,
        closeBudgetMs: 10,
        flushBudgetMs: 10,
      });

      const completion = Promise.all([shutdown(), shutdown()]);
      await vi.advanceTimersByTimeAsync(20);
      await completion;

      // The runtime is never released beneath a server that has not drained.
      expect(calls).toEqual(["recovery.stop", "logger.shutdown"]);
      expect(setExitCode).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the runtime after HTTP drains and reports a failed release", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const logger: ControlLogger = {
      emit(_level, event) {
        if (event.event === "control.service.failed") errors.push(event.errorType ?? "");
      },
      async shutdown() {
        calls.push("logger.shutdown");
      },
    };
    const setExitCode = vi.fn();
    const shutdown = createControlShutdown({
      logger,
      stopRecovery: () => calls.push("recovery.stop"),
      closeServer: async () => {
        calls.push("server.close");
      },
      closeRuntime: async () => {
        calls.push("runtime.close");
        throw new TypeError("pool already ended");
      },
      setExitCode,
    });

    await shutdown();

    expect(calls).toEqual(["recovery.stop", "server.close", "runtime.close", "logger.shutdown"]);
    expect(errors).toEqual(["TypeError"]);
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it("releases the runtime once a slow drain eventually completes", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      let finishDrain = () => {};
      const drained = new Promise<void>((resolve) => {
        finishDrain = resolve;
      });
      const shutdown = createControlShutdown({
        logger: { emit() {}, async shutdown() {} },
        stopRecovery: () => {},
        closeServer: () => drained,
        closeRuntime: async () => {
          calls.push("runtime.close");
        },
        setExitCode: () => {},
        closeBudgetMs: 10,
        flushBudgetMs: 10,
      });
      const completion = shutdown();
      await vi.advanceTimersByTimeAsync(20);
      await completion;
      expect(calls).toEqual([]);
      finishDrain();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["runtime.close"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
