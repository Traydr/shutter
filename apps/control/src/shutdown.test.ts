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
        setExitCode,
        closeBudgetMs: 10,
        flushBudgetMs: 10,
      });

      const completion = Promise.all([shutdown(), shutdown()]);
      await vi.advanceTimersByTimeAsync(20);
      await completion;

      expect(calls).toEqual(["recovery.stop", "logger.shutdown"]);
      expect(setExitCode).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
