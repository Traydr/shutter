import type { S3Client } from "@aws-sdk/client-s3";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createPdfExecutorApp } from "./app.js";

const TOKEN = "p".repeat(32);

function config() {
  return {
    controlBaseUrl: "http://control.test",
    roleToken: TOKEN,
    bucket: "test",
    s3: {} as S3Client,
    fetch: vi.fn<typeof fetch>(),
  };
}

describe("PDF executor app", () => {
  it("authenticates a wake with the executor role token", async () => {
    const run = vi.fn(() => Effect.succeed("idle" as const));
    const configured = createPdfExecutorApp(config(), run);

    const unauthorized = await configured.request("http://shutter.test/internal/v1/run-once", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    expect(unauthorized.status).toBe(401);

    const accepted = await configured.request("http://shutter.test/internal/v1/run-once", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ result: "idle" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs at most one job invocation at a time", async () => {
    let finish: ((result: "processed") => void) | undefined;
    let invocations = 0;
    const run = vi.fn(() => {
      invocations += 1;
      return invocations === 1
        ? Effect.promise(
            () =>
              new Promise<"processed">((resolve) => {
                finish = resolve;
              }),
          )
        : Effect.succeed("idle" as const);
    });
    const configured = createPdfExecutorApp(config(), run);
    const wake = { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } };

    const firstPromise = configured.request("http://shutter.test/internal/v1/run-once", wake);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const duplicate = await configured.request("http://shutter.test/internal/v1/run-once", wake);
    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toEqual({ result: "busy" });

    finish?.("processed");
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();

    const afterRelease = await configured.request("http://shutter.test/internal/v1/run-once", wake);
    expect(afterRelease.status).toBe(200);
    await expect(afterRelease.json()).resolves.toEqual({ result: "idle" });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
