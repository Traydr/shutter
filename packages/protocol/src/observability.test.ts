import { describe, expect, it } from "vitest";
import { operationalEvent, sanitizeOperationalEvent } from "./observability.js";

describe("operational events", () => {
  it("hashes identifiers, drops junk fields, and rejects concrete HTTP paths", async () => {
    const event = await operationalEvent({
      event: "executor.completed",
      spaceId: "example-private",
      sourceId: "raw-source-id",
      processingToken: "raw-processing-token",
      fields: { kind: "video", executionCycle: 2, attemptNumber: 3, durationMs: 42 },
    });
    expect(Object.keys(event).sort()).toEqual([
      "attemptNumber",
      "durationMs",
      "event",
      "executionCycle",
      "kind",
      "processingTokenHash",
      "sourceHash",
    ]);
    expect(JSON.stringify(event)).not.toContain("raw-source-id");
    expect(JSON.stringify(event)).not.toContain("raw-processing-token");

    expect(
      sanitizeOperationalEvent({
        event: "control.http.completed",
        requestId: "request-id\nsecret",
        httpRoute: "/v1/spaces/acme/sources/private-source/previews/video",
        authorization: "Bearer secret",
        outcome: "failed",
      } as never),
    ).toEqual({
      event: "control.http.completed",
      outcome: "failed",
    });

    expect(
      sanitizeOperationalEvent({
        event: "control.http.completed",
        outcome: "ready",
        httpRoute: "/v1/spaces/:spaceId/sources/:sourceId/previews/:kind",
      }),
    ).toMatchObject({
      httpRoute: "/v1/spaces/:spaceId/sources/:sourceId/previews/:kind",
    });
  });

  it("keeps Source Delivery measurements bounded and redacted", async () => {
    const event = await operationalEvent({
      event: "edge.source_delivery",
      spaceId: "example-private",
      sourceId: "raw-source-id",
      fields: {
        routeClass: "private",
        cacheOutcome: "edge-hit",
        mediaClass: "video",
        byteRangeOutcome: "edge-hit",
        originFetchResult: "not-requested",
        locator: "https://secret.example/source.mp4?signature=secret",
        range: "bytes=123-456",
      } as never,
    });

    expect(event).toMatchObject({
      event: "edge.source_delivery",
      routeClass: "private",
      cacheOutcome: "edge-hit",
      mediaClass: "video",
      byteRangeOutcome: "edge-hit",
      originFetchResult: "not-requested",
    });
    expect(JSON.stringify(event)).not.toContain("raw-source-id");
    expect(JSON.stringify(event)).not.toContain("secret.example");
    expect(JSON.stringify(event)).not.toContain("bytes=123-456");
  });
});
