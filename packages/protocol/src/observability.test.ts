import { describe, expect, it } from "vitest";
import {
  type OperationalEvent,
  type OperationalEventFields,
  operationalEvent,
  sanitizeOperationalEvent,
} from "./observability.js";

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

    // Junk reaches a logger through untyped merges at runtime; the allowlist must drop it.
    const leakyEvent: OperationalEvent = { event: "control.http.completed", outcome: "failed" };
    Object.assign(leakyEvent, {
      requestId: "request-id\nsecret",
      httpRoute: "/v1/spaces/acme/sources/private-source/previews/video",
      authorization: "Bearer secret",
    });
    expect(sanitizeOperationalEvent(leakyEvent)).toEqual({
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

  it("accepts a feature report only as identifiers", () => {
    expect(
      sanitizeOperationalEvent({
        event: "control.service.features",
        count: 2,
        features: "sourcePurge=CLOUDFLARE_ZONE_ID,EDGE_BASE_URL imgproxy=IMGPROXY_KEY",
      }),
    ).toEqual({
      event: "control.service.features",
      count: 2,
      features: "sourcePurge=CLOUDFLARE_ZONE_ID,EDGE_BASE_URL imgproxy=IMGPROXY_KEY",
    });
    expect(
      sanitizeOperationalEvent({
        event: "control.service.features",
        features: "sourcePurge=CLOUDFLARE_ZONE_ID=secret-value",
      }),
    ).toEqual({ event: "control.service.features" });
  });

  it("keeps Source Delivery measurements bounded and redacted", async () => {
    const leakyFields: OperationalEventFields = {
      routeClass: "private",
      cacheOutcome: "edge-hit",
      mediaClass: "video",
      byteRangeOutcome: "edge-hit",
      originFetchResult: "not-requested",
    };
    Object.assign(leakyFields, {
      locator: "https://secret.example/source.mp4?signature=secret",
      range: "bytes=123-456",
    });
    const event = await operationalEvent({
      event: "edge.source_delivery",
      spaceId: "example-private",
      sourceId: "raw-source-id",
      fields: leakyFields,
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
