import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { loadControlConfig } from "./server.js";

describe("ControlConfig", () => {
  it("keeps missing and empty optional values fail-closed without failing startup", async () => {
    const config = await Effect.runPromise(
      loadControlConfig({
        DATABASE_URL: "",
        ORIGIN_AUTH_TOKEN: "",
        VIDEO_EXECUTOR_BASE_URL: "",
      }),
    );

    expect(config.port).toBe(3_000);
    expect(config.databaseUrl).toBeUndefined();
    expect(config.originAuthToken).toBeUndefined();
    expect(config.videoExecutorBaseUrl).toBeUndefined();
  });

  it("still rejects malformed configured URLs", async () => {
    await expect(
      Effect.runPromise(loadControlConfig({ DATABASE_URL: "not a URL" })),
    ).rejects.toBeDefined();
  });
});
