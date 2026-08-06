import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { runCommand } from "./media.js";

describe("Executor child processes", () => {
  it.effect("collects stdout from a successful command", () =>
    Effect.gen(function* () {
      expect(
        yield* runCommand(process.execPath, ["-e", 'process.stdout.write("ready")'], 5_000),
      ).toBe("ready");
    }),
  );

  it.live("interrupts a child process when its timeout expires", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runCommand(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], 50),
      );
      expect(error).toBeDefined();
    }),
  );
});
