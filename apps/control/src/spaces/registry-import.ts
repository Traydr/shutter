import {
  decodeCapabilityKey,
  type JsonValue,
  SPACE_POLICY_SCHEMA,
  type SpacePolicy,
} from "@shutter/protocol";
import { z } from "zod";
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

const capabilityKeySchema = z.strictObject(
  {
    keyId: z.string(),
    key: z.string().transform((encoded, context) => {
      try {
        return decodeCapabilityKey(encoded);
      } catch {
        context.addIssue("capabilityKeys[] is invalid");
        return z.NEVER;
      }
    }),
  },
  { error: "capabilityKeys[] has unexpected fields" },
);

const importSpaceSchema = z.strictObject(
  {
    policy: SPACE_POLICY_SCHEMA,
    apiTokens: z.array(z.strictObject({ label: z.string(), token: z.string() })).readonly(),
    capabilityKeys: z.array(capabilityKeySchema).readonly(),
  },
  { error: "spaces[] has unexpected fields" },
);

const registryImportSchema = z
  .strictObject(
    {
      schemaVersion: z.literal("v1", { error: "registry import is not v1" }),
      spaces: z
        .array(importSpaceSchema)
        .nonempty({ error: "registry import is not v1" })
        .readonly(),
    },
    { error: "registry import has unexpected fields" },
  )
  .refine(
    (input) => new Set(input.spaces.map((space) => space.policy.id)).size === input.spaces.length,
    { error: "registry import Space IDs must be unique" },
  );

export function parseRegistryImport(value: JsonValue): RegistryImport {
  const result = registryImportSchema.safeParse(value);
  if (!result.success) {
    // An unknown field is reported ahead of any other defect so an operator
    // sees a possible secret in the wrong place before anything else.
    const issue =
      result.error.issues.find((candidate) => candidate.code === "unrecognized_keys") ??
      result.error.issues[0];
    throw new Error(issue?.message ?? "registry import is invalid");
  }
  return result.data;
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
