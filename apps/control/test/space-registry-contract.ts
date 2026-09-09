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

const otherPolicy = {
  id: "contract-other",
  routeClass: "public",
  qualities: [75],
  defaultQuality: 75,
  allowedSourceOrigins: [{ origin: "https://other.example.com" }],
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
          {
            id: "roots",
            type: "template",
            url: "https://roots.example.com/{key}",
            placeholders: { key: {} },
          },
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

    it("stores resolver credentials beside s3 resolvers and never inside policy", async () => {
      const policy = {
        ...otherPolicy,
        id: "contract-resolvers",
        allowedSourceOrigins: [
          { origin: "https://other.example.com" },
          { origin: "https://objects.example.test", pathPrefix: "/contract-bucket" },
        ],
        resolvers: [
          {
            id: "lw",
            type: "template",
            url: "https://other.example.com/cdn/{token}",
            placeholders: { token: {} },
          },
          {
            id: "media",
            type: "s3",
            endpoint: "https://objects.example.test",
            region: "auto",
            bucket: "contract-bucket",
            pathStyle: true,
            keyTemplate: "{key}",
          },
        ],
      } satisfies SpacePolicy;
      const credential = { resolverId: "media", accessKeyId: "AKIA1", secretAccessKey: "s3cr3t" };

      await expectCode(registry.createSpace(policy), "invalid");
      await expectCode(
        registry.createSpace(policy, [{ ...credential, resolverId: "lw" }]),
        "invalid",
      );
      await registry.createSpace(policy, [credential]);
      await expect(registry.getActiveSpacePolicy(policy.id)).resolves.toEqual(policy);
      const snapshot = await registry.loadEdgeSnapshot();
      expect(JSON.stringify(snapshot.spaces)).not.toContain("s3cr3t");
      expect(JSON.stringify(snapshot.spaces)).not.toContain("AKIA1");
      await expect(registry.listResolverCredentials(policy.id)).resolves.toEqual([
        { resolverId: "media", accessKeyId: "AKIA1", updatedAt: expect.any(Date) },
      ]);
      await expect(registry.getResolverCredential(policy.id, "media")).resolves.toEqual({
        accessKeyId: "AKIA1",
        secretAccessKey: "s3cr3t",
      });
      await expect(registry.getResolverCredential(policy.id, "lw")).resolves.toBeUndefined();

      // An edit that does not mention the credential keeps it.
      await registry.editSpace(policy.id, {
        qualities: policy.qualities,
        defaultQuality: policy.defaultQuality,
        allowedSourceOrigins: policy.allowedSourceOrigins,
        resolvers: policy.resolvers,
      });
      await expect(registry.getResolverCredential(policy.id, "media")).resolves.toEqual({
        accessKeyId: "AKIA1",
        secretAccessKey: "s3cr3t",
      });
      // A supplied one replaces it; dropping the resolver drops the credential.
      await registry.editSpace(policy.id, {
        qualities: policy.qualities,
        defaultQuality: policy.defaultQuality,
        allowedSourceOrigins: policy.allowedSourceOrigins,
        resolvers: policy.resolvers,
        resolverCredentials: [{ ...credential, accessKeyId: "AKIA2", secretAccessKey: "next" }],
      });
      await expect(registry.getResolverCredential(policy.id, "media")).resolves.toEqual({
        accessKeyId: "AKIA2",
        secretAccessKey: "next",
      });
      await registry.editSpace(policy.id, {
        qualities: policy.qualities,
        defaultQuality: policy.defaultQuality,
        allowedSourceOrigins: policy.allowedSourceOrigins,
        resolvers: policy.resolvers.filter((resolver) => resolver.type !== "s3"),
      });
      await expect(registry.listResolverCredentials(policy.id)).resolves.toEqual([]);
      await expectCode(
        registry.editSpace(policy.id, {
          qualities: policy.qualities,
          defaultQuality: policy.defaultQuality,
          allowedSourceOrigins: policy.allowedSourceOrigins,
          resolvers: policy.resolvers,
        }),
        "invalid",
      );
      await expectCode(registry.listResolverCredentials("missing-space"), "not_found");
    });

    it("adds, replaces, and removes one resolver at a time under the identifier rules", async () => {
      const policy = {
        ...otherPolicy,
        id: "contract-edit-resolver",
        allowedSourceOrigins: [
          { origin: "https://other.example.com" },
          { origin: "https://objects.example.test", pathPrefix: "/contract-bucket" },
        ],
      } satisfies SpacePolicy;
      const template = {
        id: "lw",
        type: "template",
        url: "https://other.example.com/cdn/{token}",
        placeholders: { token: {} },
      } as const;
      const bucket = {
        id: "media",
        type: "s3",
        endpoint: "https://objects.example.test",
        region: "auto",
        bucket: "contract-bucket",
        pathStyle: true,
        keyTemplate: "{key}",
      } as const;
      await registry.createSpace(policy);
      await expect(
        registry.editResolver(policy.id, { resolverId: "lw", resolver: template, create: true }),
      ).resolves.toMatchObject({ generation: 2, value: { policy: { resolvers: [template] } } });
      await expectCode(
        registry.editResolver(policy.id, { resolverId: "lw", resolver: template, create: true }),
        "conflict",
      );
      await expectCode(registry.editResolver(policy.id, { resolverId: "media" }), "not_found");
      await expectCode(
        registry.editResolver(policy.id, { resolverId: "media", resolver: bucket, create: true }),
        "invalid",
      );
      await expectCode(
        registry.editResolver(policy.id, {
          resolverId: "lw",
          resolver: { ...template, id: "renamed" },
        }),
        "invalid",
      );
      await registry.editResolver(policy.id, {
        resolverId: "media",
        resolver: bucket,
        credential: { resolverId: "media", accessKeyId: "AKIA1", secretAccessKey: "s" },
        create: true,
      });
      await expect(registry.getActiveSpacePolicy(policy.id)).resolves.toMatchObject({
        resolvers: [template, bucket],
      });
      await registry.editResolver(policy.id, {
        resolverId: "media",
        resolver: { ...bucket, keyTemplate: "originals/{key}" },
      });
      await expect(registry.getResolverCredential(policy.id, "media")).resolves.toEqual({
        accessKeyId: "AKIA1",
        secretAccessKey: "s",
      });
      await registry.editResolver(policy.id, { resolverId: "lw" });
      await expect(registry.getActiveSpacePolicy(policy.id)).resolves.toMatchObject({
        resolvers: [{ id: "media", keyTemplate: "originals/{key}" }],
      });
      await expectCode(
        registry.editResolver("missing-space", {
          resolverId: "lw",
          resolver: template,
          create: true,
        }),
        "not_found",
      );
    });

    it("refuses to store the retired uploadthing kind", async () => {
      await expectCode(
        registry.createSpace({
          ...otherPolicy,
          id: "contract-retired",
          resolvers: [{ id: "ut", type: "uploadthing", allowedProjectIds: ["p"] }],
        }),
        "invalid",
      );
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
      const token = await registry.issueApiToken(contractPolicy.id, "application");
      await registry.decommissionSpace(contractPolicy.id);
      await expect(
        registry.authorizeSpaceRequest(contractPolicy.id, token.value.token),
      ).resolves.toEqual({ outcome: "missing" });
      await expect(registry.getSpaceAuthorization(contractPolicy.id)).resolves.toMatchObject({
        policy: contractPolicy,
      });
      expect(
        (await registry.getSpaceAuthorization(contractPolicy.id))?.capabilityKeys.get("key-1"),
      ).toHaveLength(32);
    });

    it("authorizes a Space request only for a live token on an active Space", async () => {
      await expect(
        registry.authorizeSpaceRequest("missing-space", "x".repeat(40)),
      ).resolves.toEqual({ outcome: "missing" });

      await registry.createSpace(contractPolicy);
      await registry.createSpace(otherPolicy);
      const token = await registry.issueApiToken(contractPolicy.id, "application");
      const foreign = await registry.issueApiToken(otherPolicy.id, "application");
      const key = Uint8Array.from({ length: 32 }, (_, index) => index);
      await registry.addCapabilityKey(contractPolicy.id, "key-1", key);
      await registry.addCapabilityKey(contractPolicy.id, "key-2");

      await expect(registry.authorizeSpaceRequest(contractPolicy.id, undefined)).resolves.toEqual({
        outcome: "unauthorized",
      });
      await expect(registry.authorizeSpaceRequest(contractPolicy.id, "short")).resolves.toEqual({
        outcome: "unauthorized",
      });
      await expect(
        registry.authorizeSpaceRequest(contractPolicy.id, foreign.value.token),
      ).resolves.toEqual({ outcome: "unauthorized" });

      const authorized = await registry.authorizeSpaceRequest(contractPolicy.id, token.value.token);
      expect(authorized).toMatchObject({ outcome: "authorized", policy: contractPolicy });
      if (authorized.outcome !== "authorized") throw new Error("expected authorization");
      expect([...authorized.capabilityKeys.keys()]).toEqual(["key-1", "key-2"]);
      expect(authorized.capabilityKeys.get("key-1")).toEqual(key);

      await registry.disableCapabilityKey(contractPolicy.id, "key-1");
      const rotated = await registry.authorizeSpaceRequest(contractPolicy.id, token.value.token);
      if (rotated.outcome !== "authorized") throw new Error("expected authorization");
      expect([...rotated.capabilityKeys.keys()]).toEqual(["key-2"]);

      await registry.revokeApiToken(contractPolicy.id, token.value.id);
      await expect(
        registry.authorizeSpaceRequest(contractPolicy.id, token.value.token),
      ).resolves.toEqual({ outcome: "unauthorized" });
    });

    it("reads one Space record of any status", async () => {
      await expect(registry.getSpace(contractPolicy.id)).resolves.toBeUndefined();
      await registry.createSpace(contractPolicy);
      await expect(registry.getSpace(contractPolicy.id)).resolves.toMatchObject({
        policy: contractPolicy,
        status: "active",
      });
      await registry.decommissionSpace(contractPolicy.id);
      await expect(registry.getSpace(contractPolicy.id)).resolves.toMatchObject({
        policy: contractPolicy,
        status: "decommissioned",
        decommissionedAt: expect.any(Date),
      });
    });

    it("rolls back every write of a failed transaction", async () => {
      await registry.createSpace(contractPolicy);
      await expect(
        registry.withTransaction(async (transaction) => {
          await transaction.createSpace(otherPolicy);
          await transaction.issueApiToken(contractPolicy.id, "application");
          await transaction.addCapabilityKey(contractPolicy.id, "key-1");
          throw new Error("abandon the import");
        }),
      ).rejects.toThrow("abandon the import");
      await expect(registry.getGeneration()).resolves.toMatchObject({ generation: 1 });
      expect((await registry.listSpaces()).map((record) => record.policy.id)).toEqual([
        contractPolicy.id,
      ]);
      await expect(registry.listApiTokens(contractPolicy.id)).resolves.toEqual([]);
      await expect(registry.listCapabilityKeys(contractPolicy.id)).resolves.toEqual([]);
    });
  });
}
