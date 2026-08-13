import { describe, expect, it } from "vitest";
import {
  EdgeConfigValidationError,
  parseEdgeConfigSnapshot,
  serializeEdgeConfigSnapshot,
} from "./edge-config.js";
import { parseSpacePolicy } from "./space-policy.js";

function snapshot(): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    generation: 2,
    generatedAt: "2026-08-11T10:00:00.000Z",
    spaces: [
      {
        id: "example-private",
        routeClass: "private",
        qualities: [75],
        defaultQuality: 75,
        allowedSourceOrigins: [{ origin: "https://sources.example.com" }],
        resolvers: [],
      },
    ],
    capabilityKeys: {
      "example-private": {
        "test-key": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      },
    },
  };
}

describe("Edge configuration contract", () => {
  it("parses the complete v1 snapshot", () => {
    const parsed = parseEdgeConfigSnapshot(snapshot());
    expect(parsed.generation).toBe(2);
    expect(parsed.policyFor("example-private")?.routeClass).toBe("private");
    expect(parsed.keysFor("example-private").get("test-key")).toHaveLength(32);
  });

  it("serializes the producer shape with the same contract", () => {
    const policy = parseSpacePolicy((snapshot().spaces as unknown[])[0]);
    const wire = serializeEdgeConfigSnapshot(
      {
        generation: 2,
        spaces: [policy],
        capabilityKeys: new Map([
          [
            "example-private",
            new Map([["test-key", Uint8Array.from({ length: 32 }, (_, index) => index)]]),
          ],
        ]),
      },
      new Date("2026-08-11T10:00:00.000Z"),
    );
    expect(parseEdgeConfigSnapshot(wire).policyFor("example-private")).toBeDefined();
  });

  it("rejects unknown fields, unknown Spaces, and malformed keys", () => {
    expect(() => parseEdgeConfigSnapshot({ ...snapshot(), extra: true })).toThrow(
      EdgeConfigValidationError,
    );
    expect(() =>
      parseEdgeConfigSnapshot({
        ...snapshot(),
        capabilityKeys: { unknown: {} },
      }),
    ).toThrow("unknown Space");
    expect(() =>
      parseEdgeConfigSnapshot({
        ...snapshot(),
        capabilityKeys: { "example-private": { "test-key": "short" } },
      }),
    ).toThrow("Capability Key");
  });
});
