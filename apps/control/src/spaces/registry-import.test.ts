import { describe, expect, it } from "vitest";
import { MemorySpaceRegistry } from "./memory-registry.js";
import { importRegistry, parseRegistryImport } from "./registry-import.js";

const TOKEN = "sht_v1_0123456789abcdefghijklmnopqrstuvwxyzABCDE";
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("one-shot Space Registry import", () => {
  it("imports and reads back policies, API tokens, and Capability Keys", async () => {
    const input = parseRegistryImport({
      schemaVersion: "v1",
      spaces: [
        {
          policy: {
            id: "example-private",
            routeClass: "private",
            qualities: [75],
            defaultQuality: 75,
            allowedSourceOrigins: [{ origin: "https://sources.example.com" }],
            resolvers: [],
          },
          apiTokens: [{ label: "cutover", token: TOKEN }],
          capabilityKeys: [{ keyId: "cutover-key", key: KEY }],
        },
      ],
    });
    const registry = new MemorySpaceRegistry();

    await expect(importRegistry(registry, input)).resolves.toEqual({
      generation: 3,
      spaceCount: 1,
    });
    await expect(registry.verifyApiToken("example-private", TOKEN)).resolves.toBe(true);
    expect((await registry.loadEdgeSnapshot()).capabilityKeys.get("example-private")?.size).toBe(1);
  });

  it("rejects unknown fields before it writes", () => {
    expect(() =>
      parseRegistryImport({ schemaVersion: "v1", spaces: [], secret: "not allowed" }),
    ).toThrow("unexpected fields");
    expect(() => parseRegistryImport({ schemaVersion: "v1", spaces: [] })).toThrow(
      "registry import is not v1",
    );
  });

  it("rolls back every write when the import fails", async () => {
    const policy = {
      routeClass: "private" as const,
      qualities: [75],
      defaultQuality: 75,
      allowedSourceOrigins: [{ origin: "https://sources.example.com" }],
      resolvers: [],
    };
    const input = parseRegistryImport({
      schemaVersion: "v1",
      spaces: ["one", "two"].map((id) => ({
        policy: { ...policy, id },
        apiTokens: [{ label: "duplicate", token: TOKEN }],
        capabilityKeys: [],
      })),
    });
    const registry = new MemorySpaceRegistry();

    await expect(importRegistry(registry, input)).rejects.toThrow("already exists");
    await expect(registry.listSpaces()).resolves.toEqual([]);
    await expect(registry.loadEdgeSnapshot()).resolves.toMatchObject({ generation: 0 });
  });
});
