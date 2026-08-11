import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { operationalEvent, sanitizeOperationalEvent } from "./observability.js";

describe("operational events", () => {
  it.effect("hashes identifiers, drops junk fields, and rejects concrete HTTP paths", () =>
    Effect.gen(function* () {
      const event = yield* operationalEvent({
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
    }),
  );
});
