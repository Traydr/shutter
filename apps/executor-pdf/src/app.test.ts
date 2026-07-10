import { describe, expect, it } from "vitest";
import { app } from "./app.js";

describe("PDF executor app", () => {
  it("reports its health and keeps work routes closed", async () => {
    const health = await app.request("http://shutter.test/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true, service: "executor-pdf" });

    const work = await app.request("http://shutter.test/v1/jobs/claim");
    expect(work.status).toBe(404);
  });
});
