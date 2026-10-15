import { describe, expect, it } from "vitest";
import { issueSourceCapability, verifySourceCapability } from "./capability.js";
import {
  EdgeConfigValidationError,
  parseEdgeConfigRefreshReport,
  parseEdgeConfigSnapshot,
  serializeEdgeConfigRefreshReport,
  serializeEdgeConfigSnapshot,
} from "./edge-config.js";
import { decodeCapabilityKey } from "./key-material.js";
import { parseSpacePolicy } from "./space-policy.js";

function snapshot() {
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

  it("imports each Space's verification keys once per snapshot", async () => {
    const parsed = parseEdgeConfigSnapshot(snapshot());
    const keys = await parsed.verificationKeysFor("example-private");
    expect(await parsed.verificationKeysFor("example-private")).toBe(keys);
    expect([...keys.keys()]).toEqual(["test-key"]);
    expect(keys.get("test-key")).toMatchObject({ extractable: false, usages: ["decrypt"] });
    expect((await parsed.verificationKeysFor("unknown")).size).toBe(0);

    const capability = await issueSourceCapability(
      {
        space_id: "example-private",
        source_id: "source-01",
        purpose: "master_preview",
        kind: "pdf",
        iat: 1_800_000_000,
        exp: 1_800_000_600,
      },
      { kid: "test-key", key: decodeCapabilityKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8") },
    );
    await expect(
      verifySourceCapability(capability, {
        spaceId: "example-private",
        expectedPurpose: "master_preview",
        keys,
        now: 1_800_000_060,
      }),
    ).resolves.toMatchObject({ source_id: "source-01", kind: "pdf" });
  });

  it("serializes the producer shape with the same contract", () => {
    const wire = serializeEdgeConfigSnapshot(
      {
        generation: 2,
        spaces: snapshot().spaces.map(parseSpacePolicy),
        capabilityKeys: new Map([
          [
            "example-private",
            new Map([["test-key", Uint8Array.from({ length: 32 }, (_, index) => index)]]),
          ],
        ]),
      },
      new Date("2026-08-11T10:00:00.000Z"),
    );
    const received = JSON.parse(JSON.stringify(wire));
    expect(parseEdgeConfigSnapshot(received).policyFor("example-private")).toBeDefined();
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

  it("pins the Edge refresh report producer and consumer", () => {
    const report = JSON.parse(JSON.stringify(serializeEdgeConfigRefreshReport(2)));
    expect(parseEdgeConfigRefreshReport(report)).toEqual({
      generation: 2,
    });
    expect(() => parseEdgeConfigRefreshReport({ generation: 2, extra: true })).toThrow(
      EdgeConfigValidationError,
    );
    expect(() => parseEdgeConfigRefreshReport({ generation: -1 })).toThrow(
      "non-negative safe integer",
    );
  });
});
