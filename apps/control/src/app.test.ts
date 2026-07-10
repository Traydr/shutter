import { describe, expect, it } from "vitest";
import { app } from "./app.js";

describe("control app", () => {
  it("reports its health", async () => {
    const response = await app.request("http://shutter.test/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "control" });
  });

  it("keeps unimplemented v1 routes closed", async () => {
    const response = await app.request("http://shutter.test/v1/spaces/ernesta");
    expect(response.status).toBe(404);
  });
});
