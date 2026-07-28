import { describe, expect, it } from "vitest";
import { decodeCapabilityKey, parseCapabilityKeyRegistry } from "./key-material.js";

const EXPECTED = Uint8Array.from({ length: 32 }, (_, index) => index);

describe("capability key material", () => {
  it("decodes hex and base64url keys and rejects bad registry input", () => {
    expect(
      decodeCapabilityKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"),
    ).toEqual(EXPECTED);
    expect(decodeCapabilityKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")).toEqual(EXPECTED);
    expect(() => decodeCapabilityKey("abcd")).toThrow("must decode to 32 bytes");

    const registry = parseCapabilityKeyRegistry(
      JSON.stringify({
        "pane-view": {
          "fixture-key": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        },
      }),
    );
    expect(registry.get("pane-view")?.get("fixture-key")).toEqual(EXPECTED);
    expect(() => parseCapabilityKeyRegistry("[]")).toThrow("object keyed by Space ID");
  });
});
