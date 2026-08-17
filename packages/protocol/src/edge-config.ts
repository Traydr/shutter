import { z } from "zod";
import type { JsonValue } from "./json.js";
import { decodeCapabilityKey, encodeCapabilityKey } from "./key-material.js";
import { SPACE_POLICY_SCHEMA } from "./space-policy.js";
import type { SpacePolicy } from "./types.js";

export interface EdgeConfigSnapshotWire {
  schemaVersion: "v1";
  generation: number;
  generatedAt: string;
  spaces: readonly SpacePolicy[];
  capabilityKeys: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface EdgeConfigRefreshReportWire {
  generation: number;
}

export interface EdgeConfigSnapshotSource {
  generation: number;
  spaces: readonly SpacePolicy[];
  capabilityKeys: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;
}

export interface ParsedEdgeConfigSnapshot {
  schemaVersion: "v1";
  generation: number;
  generatedAt: number;
  policyFor(spaceId: string): SpacePolicy | undefined;
  keysFor(spaceId: string): ReadonlyMap<string, Uint8Array>;
}

export class EdgeConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeConfigValidationError";
  }
}

const KEY_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

const generationSchema = z
  .int({ error: "generation must be a non-negative safe integer" })
  .nonnegative({ error: "generation must be a non-negative safe integer" });

const generatedAtSchema = z
  .string({ error: "generatedAt must be an ISO timestamp" })
  .transform((value, context) => {
    const generatedAt = Date.parse(value);
    if (!Number.isFinite(generatedAt) || new Date(generatedAt).toISOString() !== value) {
      context.addIssue("generatedAt must be an ISO timestamp");
      return z.NEVER;
    }
    return generatedAt;
  });

const capabilityKeyEntrySchema = z
  .string({ error: "a Capability Key entry is invalid" })
  .transform((encoded, context) => {
    try {
      return decodeCapabilityKey(encoded);
    } catch {
      context.addIssue("a Capability Key entry is invalid");
      return z.NEVER;
    }
  });

const capabilityKeyRegistrySchema = z.record(
  z.string(),
  z.record(
    z.string().regex(KEY_ID_PATTERN, { error: "a Capability Key entry is invalid" }),
    capabilityKeyEntrySchema,
    { error: "capabilityKeys must map each Space to its Capability Keys" },
  ),
  { error: "capabilityKeys must be an object" },
);

const refreshReportSchema = z.strictObject(
  { generation: generationSchema },
  { error: "Edge configuration refresh report contains missing or unknown fields" },
);

const snapshotSchema = z.strictObject(
  {
    schemaVersion: z.literal("v1", { error: "schemaVersion must be v1" }),
    generation: generationSchema,
    generatedAt: generatedAtSchema,
    spaces: z.array(SPACE_POLICY_SCHEMA, { error: "spaces must be an array" }),
    capabilityKeys: capabilityKeyRegistrySchema,
  },
  { error: "Edge configuration snapshot contains missing or unknown fields" },
);

function firstIssueMessage(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

export function serializeEdgeConfigSnapshot(
  snapshot: EdgeConfigSnapshotSource,
  generatedAt: Date,
): EdgeConfigSnapshotWire {
  const capabilityKeys: Record<string, Record<string, string>> = Object.create(null);
  for (const space of snapshot.spaces) {
    const keys: Record<string, string> = Object.create(null);
    for (const [keyId, key] of snapshot.capabilityKeys.get(space.id) ?? []) {
      keys[keyId] = encodeCapabilityKey(key);
    }
    capabilityKeys[space.id] = keys;
  }
  return {
    schemaVersion: "v1",
    generation: snapshot.generation,
    generatedAt: generatedAt.toISOString(),
    spaces: snapshot.spaces,
    capabilityKeys,
  };
}

export function serializeEdgeConfigRefreshReport(generation: number): EdgeConfigRefreshReportWire {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new EdgeConfigValidationError("generation must be a non-negative safe integer");
  }
  return { generation };
}

export function parseEdgeConfigRefreshReport(value: JsonValue): EdgeConfigRefreshReportWire {
  const result = refreshReportSchema.safeParse(value);
  if (!result.success) {
    throw new EdgeConfigValidationError(
      firstIssueMessage(result.error, "Edge configuration refresh report is invalid"),
    );
  }
  return result.data;
}

export function parseEdgeConfigSnapshot(value: JsonValue): ParsedEdgeConfigSnapshot {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) {
    const message = firstIssueMessage(result.error, "Edge configuration snapshot is invalid");
    // Space policy issues are reported by SPACE_POLICY_SCHEMA under the "spaces" path.
    const policyInvalid = result.error.issues[0]?.path[0] === "spaces";
    throw new EdgeConfigValidationError(policyInvalid ? "a Space policy is invalid" : message);
  }
  const wire = result.data;
  const spaces = new Map<string, SpacePolicy>();
  for (const policy of wire.spaces) {
    if (spaces.has(policy.id)) throw new EdgeConfigValidationError("Space IDs must be unique");
    spaces.set(policy.id, policy);
  }
  const capabilityKeys = new Map<string, ReadonlyMap<string, Uint8Array>>();
  for (const [spaceId, keys] of Object.entries(wire.capabilityKeys)) {
    if (!spaces.has(spaceId)) {
      throw new EdgeConfigValidationError("capabilityKeys contains an unknown Space");
    }
    capabilityKeys.set(spaceId, new Map(Object.entries(keys)));
  }
  for (const spaceId of spaces.keys())
    capabilityKeys.set(spaceId, capabilityKeys.get(spaceId) ?? new Map());
  return Object.freeze({
    schemaVersion: "v1",
    generation: wire.generation,
    generatedAt: wire.generatedAt,
    policyFor: (spaceId: string) => spaces.get(spaceId),
    keysFor: (spaceId: string) =>
      new Map(
        [...(capabilityKeys.get(spaceId) ?? [])].map(([keyId, key]) => [
          keyId,
          Uint8Array.from(key),
        ]),
      ),
  });
}
