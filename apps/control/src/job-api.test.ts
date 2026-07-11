import { issueSourceCapability } from "@shutter/protocol";
import { describe, expect, it } from "vitest";
import { createJobApi } from "./job-api.js";
import { InMemoryJobStore } from "./job-store.js";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const KID = "test-key";
const SPACE_TOKEN = "s".repeat(32);
const VIDEO_TOKEN = "v".repeat(32);
const NOW = new Date("2026-07-11T00:00:00Z");

async function capability(): Promise<string> {
  const seconds = Math.floor(NOW.getTime() / 1_000);
  return issueSourceCapability(
    {
      space_id: "pane-view",
      source_id: "source-1",
      purpose: "preview_job",
      kind: "video",
      locator: "https://pane-view.traydr.dev/source-1.mp4",
      iat: seconds - 60,
      exp: seconds + 3_600,
    },
    { kid: KID, key: KEY },
  );
}

function runtime(store: InMemoryJobStore) {
  return {
    store,
    now: () => NOW,
    spaceApiTokens: () => new Map([["pane-view", [SPACE_TOKEN]]]),
    capabilityKeys: () => new Map([["pane-view", new Map([[KID, KEY]])]]),
    executorToken: (kind: "video" | "pdf") => (kind === "video" ? VIDEO_TOKEN : undefined),
  };
}

describe("job API", () => {
  it("submits, polls, claims, and completes one canonical video job", async () => {
    const store = new InMemoryJobStore();
    const app = createJobApi(runtime(store));
    const resource = "http://shutter.test/v1/spaces/pane-view/sources/source-1/previews/video";
    const submitted = await app.request(resource, {
      method: "PUT",
      headers: { authorization: `Bearer ${SPACE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sourceCapability: await capability() }),
    });
    expect(submitted.status).toBe(202);
    expect(submitted.headers.get("retry-after")).toBe("5");

    const claim = await app.request("http://shutter.test/internal/v1/executors/video/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${VIDEO_TOKEN}` },
    });
    expect(claim.status).toBe(200);
    const work = await claim.json<Record<string, unknown>>();
    expect(work).not.toHaveProperty("sourceCapability");
    expect(work.locator).toBe("https://pane-view.traydr.dev/source-1.mp4");

    const completed = await app.request(
      "http://shutter.test/internal/v1/executors/video/jobs/pane-view/source-1/complete",
      {
        method: "POST",
        headers: { authorization: `Bearer ${VIDEO_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          processingToken: work.processingToken,
          masterKey: work.outputKey,
          width: 1920,
          height: 1080,
          format: "webp",
          objectEtag: "etag-1",
        }),
      },
    );
    expect(completed.status).toBe(204);

    const ready = await app.request(resource, {
      headers: { authorization: `Bearer ${SPACE_TOKEN}` },
    });
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      status: "ready",
      master: {
        sourceId: "source-1",
        kind: "video",
        width: 1920,
        height: 1080,
        format: "webp",
      },
    });
  });

  it("rejects cross-kind executor credentials and malformed submissions", async () => {
    const app = createJobApi(runtime(new InMemoryJobStore()));
    const unauthorized = await app.request("http://shutter.test/internal/v1/executors/pdf/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${VIDEO_TOKEN}` },
    });
    expect(unauthorized.status).toBe(401);

    const malformed = await app.request(
      "http://shutter.test/v1/spaces/pane-view/sources/source-1/previews/video",
      {
        method: "PUT",
        headers: { authorization: `Bearer ${SPACE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ sourceCapability: await capability(), extra: true }),
      },
    );
    expect(malformed.status).toBe(400);
  });
});
