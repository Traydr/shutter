import { describe, expect, it, vi } from "vitest";
import { emitOperationalEvent, operationalEvent } from "./observability.js";

describe("operational events", () => {
  it("emits only allowlisted redacted fields", async () => {
    const event = await operationalEvent({
      event: "executor.completed",
      spaceId: "pane-view",
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
  });

  it("writes one structured object without sensitive-shaped strings", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const event = await operationalEvent({
      event: "edge.rendition",
      spaceId: "space",
      sourceId: "https://source.example/secret?token=value",
      fields: { routeClass: "private", cacheOutcome: "edge-hit" },
    });
    emitOperationalEvent("info", event);
    expect(info).toHaveBeenCalledWith(event);
    expect(JSON.stringify(info.mock.calls)).not.toContain("https://source.example");
    info.mockRestore();
  });

  it("accepts only safe request completion metadata", async () => {
    const event = await operationalEvent({
      event: "control.http.completed",
      fields: {
        requestId: "0198f407-3177-7000-8000-000000000001",
        httpMethod: "GET",
        httpRoute: "/v1/spaces/:spaceId/sources/:sourceId/previews/:kind",
        httpStatusCode: 401,
        durationMs: 12,
        outcome: "failed",
        errorType: "ProtocolError",
      },
    });

    expect(event).toEqual({
      event: "control.http.completed",
      requestId: "0198f407-3177-7000-8000-000000000001",
      httpMethod: "GET",
      httpRoute: "/v1/spaces/:spaceId/sources/:sourceId/previews/:kind",
      httpStatusCode: 401,
      durationMs: 12,
      outcome: "failed",
      errorType: "ProtocolError",
    });
  });

  it("drops invalid runtime metadata before emitting a shared event", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    emitOperationalEvent("info", {
      event: "control.http.completed",
      requestId: "request-id\nsecret",
      httpMethod: "GET\r",
      httpRoute: "/v1/source?token=secret",
      httpStatusCode: 999,
      durationMs: -1,
      outcome: "failed",
      errorType: "Error\nsecret",
      authorization: "Bearer secret",
    } as never);

    expect(info).toHaveBeenCalledWith({
      event: "control.http.completed",
      outcome: "failed",
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret");
    info.mockRestore();
  });
});
