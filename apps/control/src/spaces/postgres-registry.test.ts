import { randomBytes } from "node:crypto";
import type { SpacePolicy } from "@shutter/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSpaceRegistryContract } from "../../test/space-registry-contract.js";
import { createPostgresTestLifecycle, type PostgresTestLifecycle } from "../postgres-test.js";
import { CapabilityKeyEncryption } from "./encryption.js";
import { PostgresSpaceRegistry } from "./postgres-registry.js";
import { SpaceRegistryError } from "./registry.js";
import { importRegistry, parseRegistryImport } from "./registry-import.js";

const now = new Date("2026-08-11T12:00:00.000Z");
const publicPolicy = {
  id: "example-public",
  routeClass: "public",
  qualities: [30, 50, 75],
  defaultQuality: 75,
  allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/media" }],
  resolvers: [{ id: "uploadthing", type: "uploadthing", allowedProjectIds: ["example_project"] }],
} satisfies SpacePolicy;
const privatePolicy = {
  id: "example-private",
  routeClass: "private",
  qualities: [30, 75, 80],
  defaultQuality: 75,
  allowedSourceOrigins: [{ origin: "https://private.example.com" }],
  resolvers: [],
} satisfies SpacePolicy;

describe("PostgresSpaceRegistry", () => {
  let test: PostgresTestLifecycle;
  let registry: PostgresSpaceRegistry;

  beforeAll(async () => {
    test = await createPostgresTestLifecycle();
  });

  afterAll(async () => test.close());

  beforeEach(async () => {
    await test.pool.query(`truncate table
      space_api_tokens, space_capability_keys, space_resolvers, space_source_origins,
      spaces, space_registry_metadata restart identity`);
    await test.pool.query(`insert into space_registry_metadata (generation) values (0)`);
    registry = new PostgresSpaceRegistry(test.pool, {
      encryption: new CapabilityKeyEncryption(randomBytes(32).toString("hex")),
      now: () => now,
    });
  });

  registerSpaceRegistryContract("Postgres", () => registry);

  it("stores policy through immutable database identities and increments one generation per write", async () => {
    await expect(registry.createSpace(publicPolicy)).resolves.toMatchObject({ generation: 1 });
    await expect(
      registry.editSpace(publicPolicy.id, {
        qualities: [50, 75],
        defaultQuality: 50,
        allowedSourceOrigins: [{ origin: "https://new-sources.example.com" }],
        resolvers: [{ id: "uploadthing", type: "uploadthing", allowedProjectIds: ["new_project"] }],
      }),
    ).resolves.toMatchObject({ generation: 2 });
    expect(await registry.getActiveSpacePolicy(publicPolicy.id)).toEqual({
      ...publicPolicy,
      qualities: [50, 75],
      defaultQuality: 50,
      allowedSourceOrigins: [{ origin: "https://new-sources.example.com" }],
      resolvers: [{ id: "uploadthing", type: "uploadthing", allowedProjectIds: ["new_project"] }],
    });
    await expect(registry.decommissionSpace(publicPolicy.id)).resolves.toMatchObject({
      generation: 3,
      value: { status: "decommissioned", decommissionedAt: now },
    });
    await expect(registry.getActiveSpacePolicy(publicPolicy.id)).resolves.toBeUndefined();
    await expect(registry.createSpace(publicPolicy)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      test.pool.query(`delete from spaces where space_id = $1`, [publicPolicy.id]),
    ).rejects.toThrow("must be decommissioned");
  });

  it("enforces unique constraints and foreign keys", async () => {
    await registry.createSpace(publicPolicy);
    const space = await test.pool.query<{ id: number }>(
      `select id from spaces where space_id = $1`,
      [publicPolicy.id],
    );
    const recordId = space.rows[0]?.id;
    expect(recordId).toBeTypeOf("number");
    await expect(
      test.pool.query(
        `insert into space_source_origins (space_id, origin, path_prefix) values ($1, $2, $3)`,
        [recordId, "https://sources.example.com", "/media"],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      test.pool.query(
        `insert into space_resolvers
          (space_id, resolver_id, resolver_type, allowed_project_ids)
         values ($1, 'uploadthing', 'uploadthing', array['another'])`,
        [recordId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      test.pool.query(
        `insert into space_source_origins (space_id, origin, path_prefix)
         values (2147483647, 'https://sources.example.com', '/')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects public identifier and route-class changes in direct SQL", async () => {
    await registry.createSpace(publicPolicy);
    await expect(
      test.pool.query(`update spaces set space_id = 'replacement' where space_id = $1`, [
        publicPolicy.id,
      ]),
    ).rejects.toThrow("public identifier is immutable");
    await expect(
      test.pool.query(`update spaces set route_class = 'private' where space_id = $1`, [
        publicPolicy.id,
      ]),
    ).rejects.toThrow("route class is immutable");
  });

  it("rejects a Source Resolver for a private Space in direct SQL", async () => {
    await registry.createSpace(privatePolicy);
    const space = await test.pool.query<{ id: number }>(
      `select id from spaces where space_id = $1`,
      [privatePolicy.id],
    );
    await expect(
      test.pool.query(
        `insert into space_resolvers
          (space_id, resolver_id, resolver_type, allowed_project_ids)
         values ($1, 'uploadthing', 'uploadthing', array['example'])`,
        [space.rows[0]?.id],
      ),
    ).rejects.toThrow("private Space cannot have a Source Resolver");
  });

  it("issues, verifies, and revokes a globally unique hashed API token", async () => {
    await registry.createSpace(publicPolicy);
    await registry.createSpace(privatePolicy);
    const token = "test_api_token_abcdefghijklmnopqrstuvwxyz0123456789";
    const issued = await registry.issueApiToken(publicPolicy.id, "application", token);
    expect(issued).toMatchObject({ generation: 3, value: { token, label: "application" } });
    const stored = await test.pool.query<{ token_hash: string }>(
      `select token_hash from space_api_tokens`,
    );
    expect(stored.rows[0]?.token_hash).not.toContain(token);
    await expect(registry.verifyApiToken(publicPolicy.id, token)).resolves.toBe(true);
    await expect(registry.verifyApiToken(privatePolicy.id, token)).resolves.toBe(false);
    await expect(
      registry.issueApiToken(privatePolicy.id, "duplicate", token),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(registry.revokeApiToken(publicPolicy.id, issued.value.id)).resolves.toMatchObject({
      generation: 4,
    });
    await expect(registry.verifyApiToken(publicPolicy.id, token)).resolves.toBe(false);
  });

  it("seals accepted Capability Keys and returns one atomic active snapshot", async () => {
    await registry.createSpace(publicPolicy);
    await registry.createSpace(privatePolicy);
    const key = randomBytes(32);
    const accepted = await registry.addCapabilityKey(privatePolicy.id, "key-1", key);
    expect(accepted).toMatchObject({ generation: 3, value: { keyId: "key-1" } });
    const stored = await test.pool.query<{ sealed_key: string }>(
      `select sealed_key from space_capability_keys`,
    );
    expect(stored.rows[0]?.sealed_key).not.toBe(key.toString("base64url"));

    const snapshot = await registry.loadEdgeSnapshot();
    expect(snapshot).toMatchObject({
      schemaVersion: "v1",
      generation: 3,
      registryUpdatedAt: now,
      spaces: [publicPolicy, privatePolicy],
    });
    expect(snapshot.capabilityKeys.get(privatePolicy.id)?.get("key-1")).toEqual(
      Uint8Array.from(key),
    );

    await expect(registry.disableCapabilityKey(privatePolicy.id, "key-1")).resolves.toMatchObject({
      generation: 4,
    });
    expect((await registry.loadEdgeSnapshot()).capabilityKeys.get(privatePolicy.id)?.size).toBe(0);
  });

  it("fails Capability Key reads and writes when encryption is not configured", async () => {
    const unconfigured = new PostgresSpaceRegistry(test.pool, { now: () => now });
    await unconfigured.createSpace(privatePolicy);
    const token = await unconfigured.issueApiToken(privatePolicy.id, "application");
    await expect(unconfigured.loadEdgeSnapshot()).rejects.toEqual(
      new SpaceRegistryError("unavailable", "Capability Key encryption is not configured"),
    );
    await expect(unconfigured.addCapabilityKey(privatePolicy.id, "key-1")).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(unconfigured.getSpaceAuthorization(privatePolicy.id)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      unconfigured.authorizeSpaceRequest(privatePolicy.id, token.value.token),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(unconfigured.getActiveSpacePolicy(privatePolicy.id)).resolves.toEqual(
      privatePolicy,
    );
    await expect(unconfigured.getSpace(privatePolicy.id)).resolves.toMatchObject({
      policy: privatePolicy,
    });
  });

  it("excludes an undecryptable Capability Key instead of failing the Space", async () => {
    const reported = vi.fn<(scope: string, count: number) => void>();
    const tolerant = new PostgresSpaceRegistry(test.pool, {
      encryption: new CapabilityKeyEncryption(randomBytes(32).toString("hex")),
      now: () => now,
      onUndecryptableKeys: reported,
    });
    await tolerant.createSpace(privatePolicy);
    const token = await tolerant.issueApiToken(privatePolicy.id, "application");
    await tolerant.addCapabilityKey(privatePolicy.id, "key-1");
    await tolerant.addCapabilityKey(privatePolicy.id, "key-2");
    await test.pool.query(
      `update space_capability_keys set sealed_key = 'AAAA' where key_id = 'key-1'`,
    );

    const authorized = await tolerant.authorizeSpaceRequest(privatePolicy.id, token.value.token);
    if (authorized.outcome !== "authorized") throw new Error("expected authorization");
    expect([...authorized.capabilityKeys.keys()]).toEqual(["key-2"]);
    const claim = await tolerant.getSpaceAuthorization(privatePolicy.id);
    expect([...(claim?.capabilityKeys.keys() ?? [])]).toEqual(["key-2"]);
    const snapshot = await tolerant.loadEdgeSnapshot();
    expect([...(snapshot.capabilityKeys.get(privatePolicy.id)?.keys() ?? [])]).toEqual(["key-2"]);
    expect(reported.mock.calls).toEqual([
      ["space_authorization", 1],
      ["space_authorization", 1],
      ["edge_snapshot", 1],
    ]);
  });

  it("rolls back the complete cutover import when one credential conflicts", async () => {
    const token = "test_api_token_abcdefghijklmnopqrstuvwxyz0123456789";
    const input = parseRegistryImport({
      schemaVersion: "v1",
      spaces: [publicPolicy, privatePolicy].map((policy) => ({
        policy,
        apiTokens: [{ label: "duplicate", token }],
        capabilityKeys: [],
      })),
    });

    await expect(importRegistry(registry, input)).rejects.toMatchObject({ code: "conflict" });
    await expect(registry.listSpaces()).resolves.toEqual([]);
    await expect(registry.loadEdgeSnapshot()).resolves.toMatchObject({ generation: 0 });
  });
});
