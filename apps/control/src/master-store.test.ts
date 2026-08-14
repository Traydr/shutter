import { describe, expect, it } from "vitest";
import { createMasterStore, MASTER_READ_EXPIRY_SECONDS } from "./master-store.js";

describe("master store", () => {
  it("creates a bounded read-only presigned GET", async () => {
    const store = createMasterStore({
      endpoint: "https://account.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "shutter-media",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const signed = new URL(await store.presignGet("masters/v1/space/fingerprint/video.webp"));
    expect(signed.pathname).toBe("/shutter-media/masters/v1/space/fingerprint/video.webp");
    expect(signed.searchParams.get("X-Amz-Expires")).toBe(String(MASTER_READ_EXPIRY_SECONDS));
    expect(signed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/u);
  });
});
