import { decodeCapabilityKey, parseSpacePolicy, type SpacePolicy } from "@shutter/protocol";
import type { SpaceRegistry } from "./registry.js";

export interface RegistryImportSpace {
  policy: SpacePolicy;
  apiTokens: readonly { label: string; token: string }[];
  capabilityKeys: readonly { keyId: string; key: Uint8Array }[];
}

export interface RegistryImport {
  schemaVersion: "v1";
  spaces: readonly RegistryImportSpace[];
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort().join(",");
  if (actual !== [...keys].sort().join(",")) throw new Error(`${name} has unexpected fields`);
}

export function parseRegistryImport(value: unknown): RegistryImport {
  const input = object(value, "registry import");
  exactKeys(input, ["schemaVersion", "spaces"], "registry import");
  if (input.schemaVersion !== "v1" || !Array.isArray(input.spaces) || input.spaces.length === 0) {
    throw new Error("registry import is not v1");
  }
  const spaces = input.spaces.map((rawSpace, spaceIndex) => {
    const space = object(rawSpace, `spaces[${spaceIndex}]`);
    exactKeys(space, ["policy", "apiTokens", "capabilityKeys"], `spaces[${spaceIndex}]`);
    const policy = parseSpacePolicy(space.policy);
    if (!Array.isArray(space.apiTokens) || !Array.isArray(space.capabilityKeys)) {
      throw new Error(`spaces[${spaceIndex}] credentials must be arrays`);
    }
    const apiTokens = space.apiTokens.map((rawToken, tokenIndex) => {
      const token = object(rawToken, `apiTokens[${tokenIndex}]`);
      exactKeys(token, ["label", "token"], `apiTokens[${tokenIndex}]`);
      if (typeof token.label !== "string" || typeof token.token !== "string") {
        throw new Error(`apiTokens[${tokenIndex}] is invalid`);
      }
      return { label: token.label, token: token.token };
    });
    const capabilityKeys = space.capabilityKeys.map((rawKey, keyIndex) => {
      const key = object(rawKey, `capabilityKeys[${keyIndex}]`);
      exactKeys(key, ["keyId", "key"], `capabilityKeys[${keyIndex}]`);
      if (typeof key.keyId !== "string" || typeof key.key !== "string") {
        throw new Error(`capabilityKeys[${keyIndex}] is invalid`);
      }
      return { keyId: key.keyId, key: decodeCapabilityKey(key.key) };
    });
    return { policy, apiTokens, capabilityKeys };
  });
  if (new Set(spaces.map((space) => space.policy.id)).size !== spaces.length) {
    throw new Error("registry import Space IDs must be unique");
  }
  return { schemaVersion: "v1", spaces };
}

function equalBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (left === undefined || left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

export async function importRegistry(
  registry: SpaceRegistry,
  input: RegistryImport,
): Promise<{ generation: number; spaceCount: number }> {
  let generation = 0;
  await registry.withTransaction(async (transactionRegistry) => {
    for (const space of input.spaces) {
      generation = (await transactionRegistry.createSpace(space.policy)).generation;
      for (const token of space.apiTokens) {
        generation = (
          await transactionRegistry.issueApiToken(space.policy.id, token.label, token.token)
        ).generation;
      }
      for (const key of space.capabilityKeys) {
        generation = (
          await transactionRegistry.addCapabilityKey(space.policy.id, key.keyId, key.key)
        ).generation;
      }
    }
    const snapshot = await transactionRegistry.loadEdgeSnapshot();
    if (
      snapshot.spaces.length !== input.spaces.length ||
      JSON.stringify(snapshot.spaces) !== JSON.stringify(input.spaces.map((space) => space.policy))
    ) {
      throw new Error("the imported Space policies did not verify");
    }
    for (const space of input.spaces) {
      const storedKeys = snapshot.capabilityKeys.get(space.policy.id);
      if (
        storedKeys?.size !== space.capabilityKeys.length ||
        space.capabilityKeys.some((key) => !equalBytes(storedKeys.get(key.keyId), key.key))
      ) {
        throw new Error("the imported Capability Keys did not verify");
      }
      for (const token of space.apiTokens) {
        if (!(await transactionRegistry.verifyApiToken(space.policy.id, token.token))) {
          throw new Error("an imported API token did not verify");
        }
      }
    }
  });
  return { generation, spaceCount: input.spaces.length };
}
