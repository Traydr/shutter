import type { SpacePolicy } from "@shutter/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { SpaceRegistry } from "../src/spaces/registry.js";

const contractPolicy = {
  id: "contract-private",
  routeClass: "private",
  qualities: [50, 75],
  defaultQuality: 75,
  allowedSourceOrigins: [{ origin: "https://sources.example.com" }],
  resolvers: [],
} satisfies SpacePolicy;

export function registerSpaceRegistryContract(
  name: string,
  createRegistry: () => SpaceRegistry | Promise<SpaceRegistry>,
): void {
  describe(`${name} SpaceRegistry contract`, () => {
    let registry: SpaceRegistry;

    beforeEach(async () => {
      registry = await createRegistry();
    });

    it("owns the active Space lifecycle and generation", async () => {
      await expect(registry.createSpace(contractPolicy)).resolves.toMatchObject({ generation: 1 });
      await expect(registry.getGeneration()).resolves.toMatchObject({ generation: 1 });
      await expect(registry.getActiveSpacePolicy(contractPolicy.id)).resolves.toEqual(
        contractPolicy,
      );
      await expect(registry.decommissionSpace(contractPolicy.id)).resolves.toMatchObject({
        generation: 2,
        value: { status: "decommissioned" },
      });
      await expect(registry.getActiveSpacePolicy(contractPolicy.id)).resolves.toBeUndefined();
    });

    it("issues and revokes API tokens without accepting malformed input", async () => {
      await registry.createSpace(contractPolicy);
      const issued = await registry.issueApiToken(contractPolicy.id, "application");
      await expect(registry.verifyApiToken(contractPolicy.id, "short")).resolves.toBe(false);
      await expect(registry.verifyApiToken(contractPolicy.id, issued.value.token)).resolves.toBe(
        true,
      );
      await registry.revokeApiToken(contractPolicy.id, issued.value.id);
      await expect(registry.verifyApiToken(contractPolicy.id, issued.value.token)).resolves.toBe(
        false,
      );
    });

    it("adds and disables Capability Keys in the atomic Edge snapshot", async () => {
      await registry.createSpace(contractPolicy);
      const issued = await registry.addCapabilityKey(contractPolicy.id, "key-1");
      expect(
        (await registry.loadEdgeSnapshot()).capabilityKeys.get(contractPolicy.id)?.get("key-1"),
      ).toEqual(Uint8Array.from(Buffer.from(issued.value.key, "base64url")));
      await registry.disableCapabilityKey(contractPolicy.id, "key-1");
      expect(
        (await registry.loadEdgeSnapshot()).capabilityKeys.get(contractPolicy.id)?.has("key-1"),
      ).toBe(false);
    });

    it("retains authorization policy for work accepted before decommissioning", async () => {
      await registry.createSpace(contractPolicy);
      await registry.addCapabilityKey(
        contractPolicy.id,
        "key-1",
        Uint8Array.from({ length: 32 }, (_, index) => index),
      );
      await registry.decommissionSpace(contractPolicy.id);
      await expect(
        registry.getActiveSpaceAuthorization(contractPolicy.id),
      ).resolves.toBeUndefined();
      await expect(registry.getSpaceAuthorization(contractPolicy.id)).resolves.toMatchObject({
        policy: contractPolicy,
      });
      expect(
        (await registry.getSpaceAuthorization(contractPolicy.id))?.capabilityKeys.get("key-1"),
      ).toHaveLength(32);
    });
  });
}
