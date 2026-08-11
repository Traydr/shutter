import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { loadControlConfig } from "./server.js";

describe("ControlConfig", () => {
  it.effect("keeps missing and empty optional values fail-closed without failing startup", () =>
    Effect.gen(function* () {
      const config = yield* loadControlConfig({
        DATABASE_URL: "",
        ORIGIN_AUTH_TOKEN: "",
        VIDEO_EXECUTOR_BASE_URL: "",
      });

      expect(config.port).toBe(3_000);
      expect(config.databaseUrl).toBeUndefined();
      expect(config.originAuthToken).toBeUndefined();
      expect(config.videoExecutorBaseUrl).toBeUndefined();
    }),
  );

  it.effect("still rejects malformed configured URLs", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadControlConfig({ DATABASE_URL: "not a URL" }));
      expect(error).toBeDefined();
    }),
  );
});
