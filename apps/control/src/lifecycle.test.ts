import { describe, expect, it, vi } from "vitest";
import { createControlShutdown } from "./lifecycle.js";
import type { ControlLogger } from "./logging.js";

describe("Control process lifecycle", () => {
  it("stops work and HTTP before flushing logs exactly once", async () => {
    const calls: string[] = [];
    const logger: ControlLogger = {
      emit(_level, event) {
        calls.push(`emit:${event.event}`);
      },
      async shutdown() {
        calls.push("logger.shutdown");
      },
    };
    const shutdown = createControlShutdown({
      logger,
      stopRecovery: () => calls.push("recovery.stop"),
      closeServer: async () => {
        calls.push("server.close");
      },
      setExitCode: vi.fn(),
      timeoutMs: 1_000,
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(calls).toEqual([
      "emit:control.service.stopping",
      "recovery.stop",
      "server.close",
      "logger.shutdown",
    ]);
  });

  it("still flushes logs and marks the process failed when HTTP shutdown fails", async () => {
    const emit = vi.fn<ControlLogger["emit"]>();
    const logger: ControlLogger = { emit, shutdown: vi.fn(async () => {}) };
    const setExitCode = vi.fn();
    const shutdown = createControlShutdown({
      logger,
      stopRecovery: vi.fn(),
      closeServer: async () => Promise.reject(new Error("socket secret")),
      setExitCode,
      timeoutMs: 1_000,
    });

    await shutdown();

    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(logger.shutdown).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("error", {
      event: "control.service.failed",
      outcome: "failed",
      failureCode: "service_unavailable",
      errorType: "Error",
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("socket secret");
  });
});
