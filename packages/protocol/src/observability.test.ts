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
});
