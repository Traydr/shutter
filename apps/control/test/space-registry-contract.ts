import { parseSpacePolicy, type SpacePolicy } from "@shutter/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { SpaceRegistry, SpaceRegistryErrorCode } from "../src/spaces/registry.js";
import { SpaceRegistryError } from "../src/spaces/registry.js";

const contractPolicy = {
  id: "contract-private",
  routeClass: "private",
  qualities: [50, 75],
  defaultQuality: 75,
  allowedSourceOrigins: [{ origin: "https://sources.example.com" }],
  resolvers: [],
} satisfies SpacePolicy;

async function expectCode(work: Promise<unknown>, code: SpaceRegistryErrorCode): Promise<void> {
  await expect(work).rejects.toSatisfy(
    (error) => error instanceof SpaceRegistryError && error.code === code,
    `expected SpaceRegistryError with code ${code}`,
  );
}

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

    it("bumps the generation exactly once for every mutation", async () => {
      await expect(registry.createSpace(contractPolicy)).resolves.toMatchObject({ generation: 1 });
      await expect(
        registry.editSpace(contractPolicy.id, {
          qualities: [50, 75],
          defaultQuality: 50,
          allowedSourceOrigins: [{ origin: "https://sources.example.com" }],
          resolvers: [],
        }),
      ).resolves.toMatchObject({ generation: 2 });
      const token = await registry.issueApiToken(contractPolicy.id, "application");
      expect(token.generation).toBe(3);
      await expect(
        registry.revokeApiToken(contractPolicy.id, token.value.id),
      ).resolves.toMatchObject({ generation: 4 });
      await expect(registry.addCapabilityKey(contractPolicy.id, "key-1")).resolves.toMatchObject({
        generation: 5,
      });
      await expect(
        registry.disableCapabilityKey(contractPolicy.id, "key-1"),
      ).resolves.toMatchObject({ generation: 6 });
      await expect(registry.decommissionSpace(contractPolicy.id)).resolves.toMatchObject({
        generation: 7,
      });
    });

    it("round-trips every policy spelling through its canonical parse", async () => {
      const spelled = {
        id: "contract-round-trip",
        routeClass: "public",
        qualities: [40, 80],
        defaultQuality: 80,
        allowedSourceOrigins: [
          { origin: "https://roots.example.com", pathPrefix: "/" },
          { origin: "https://media.example.com", pathPrefix: "/media/" },
        ],
        resolvers: [
          { id: "uploadthing", type: "uploadthing", allowedProjectIds: ["contract_project"] },
        ],
      } satisfies SpacePolicy;
      const canonical = parseSpacePolicy(spelled);
      await registry.createSpace(spelled);
      await expect(registry.getActiveSpacePolicy(spelled.id)).resolves.toEqual(canonical);
      const [record] = await registry.listSpaces();
      expect(record?.policy).toEqual(canonical);
      const edited = await registry.editSpace(spelled.id, {
        qualities: spelled.qualities,
        defaultQuality: spelled.defaultQuality,
        allowedSourceOrigins: [{ origin: "https://roots.example.com", pathPrefix: "//" }],
        resolvers: spelled.resolvers,
      });
      expect(edited.value.policy.allowedSourceOrigins).toEqual([
        { origin: "https://roots.example.com" },
      ]);
      await expect(registry.getActiveSpacePolicy(spelled.id)).resolves.toEqual(edited.value.policy);
    });

    it("reports the same error code for every failure from either adapter", async () => {
      await expectCode(registry.issueApiToken("missing-space", ""), "not_found");
      await expectCode(registry.addCapabilityKey("missing-space", "key-1"), "not_found");
      await expectCode(registry.listApiTokens("missing-space"), "not_found");
      await expectCode(registry.listCapabilityKeys("missing-space"), "not_found");
      await expectCode(registry.decommissionSpace("missing-space"), "not_found");

      await registry.createSpace(contractPolicy);
      await expectCode(registry.createSpace(contractPolicy), "conflict");
      await expectCode(registry.issueApiToken(contractPolicy.id, ""), "invalid");
      await expectCode(
        registry.issueApiToken(contractPolicy.id, "application", "short"),
        "invalid",
      );
      const issued = await registry.issueApiToken(contractPolicy.id, "application");
      await expectCode(
        registry.issueApiToken(contractPolicy.id, "duplicate", issued.value.token),
        "conflict",
      );
      await expectCode(registry.revokeApiToken(contractPolicy.id, 999), "not_found");
      await expectCode(registry.addCapabilityKey(contractPolicy.id, "not valid!"), "invalid");
      await registry.addCapabilityKey(contractPolicy.id, "key-1");
      await expectCode(registry.addCapabilityKey(contractPolicy.id, "key-1"), "conflict");
      await expectCode(registry.disableCapabilityKey(contractPolicy.id, "missing"), "not_found");

      await registry.decommissionSpace(contractPolicy.id);
      await expectCode(
        registry.editSpace(contractPolicy.id, {
          qualities: contractPolicy.qualities,
          defaultQuality: contractPolicy.defaultQuality,
          allowedSourceOrigins: contractPolicy.allowedSourceOrigins,
          resolvers: [],
        }),
        "not_found",
      );
      await expectCode(registry.issueApiToken(contractPolicy.id, "application"), "not_found");
    });

    it("keeps the credential kill switches available on a decommissioned Space", async () => {
      await registry.createSpace(contractPolicy);
      const token = await registry.issueApiToken(contractPolicy.id, "application");
      await registry.addCapabilityKey(contractPolicy.id, "key-1");
      await registry.decommissionSpace(contractPolicy.id);
      await expect(
        registry.revokeApiToken(contractPolicy.id, token.value.id),
      ).resolves.toMatchObject({ value: { revokedAt: expect.any(Date) } });
      await expect(
        registry.disableCapabilityKey(contractPolicy.id, "key-1"),
      ).resolves.toMatchObject({ value: { disabledAt: expect.any(Date) } });
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
