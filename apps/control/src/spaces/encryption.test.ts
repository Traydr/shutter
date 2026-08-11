import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CapabilityKeyEncryption, EncryptionConfigurationError } from "./encryption.js";

describe("CapabilityKeyEncryption", () => {
  it.each([
    randomBytes(32).toString("hex"),
    randomBytes(32).toString("base64url"),
  ])("round trips a Capability Key with a supported master-key encoding", (masterKey) => {
    const encryption = new CapabilityKeyEncryption(masterKey);
    const key = randomBytes(32);
    const sealed = encryption.seal("example-private", "key-1", key);
    expect(encryption.open("example-private", "key-1", sealed)).toEqual(Uint8Array.from(key));
  });

  it("authenticates the public Space identifier and Capability Key identifier", () => {
    const encryption = new CapabilityKeyEncryption(randomBytes(32).toString("hex"));
    const sealed = encryption.seal("example-private", "key-1", randomBytes(32));
    expect(() => encryption.open("another-space", "key-1", sealed)).toThrow(
      EncryptionConfigurationError,
    );
    expect(() => encryption.open("example-private", "key-2", sealed)).toThrow(
      EncryptionConfigurationError,
    );
  });

  it("rejects a malformed master key", () => {
    expect(() => new CapabilityKeyEncryption("too-short")).toThrow(EncryptionConfigurationError);
  });
});
