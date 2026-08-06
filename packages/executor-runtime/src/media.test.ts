import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runCommand } from "./media.js";

describe("Executor child processes", () => {
  it("collects stdout from a successful command", async () => {
    await expect(
      Effect.runPromise(
        runCommand(process.execPath, ["-e", 'process.stdout.write("ready")'], 5_000),
      ),
    ).resolves.toBe("ready");
  });

  it("interrupts a child process when its timeout expires", async () => {
    await expect(
      Effect.runPromise(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], 50)),
    ).rejects.toBeDefined();
  });
});
