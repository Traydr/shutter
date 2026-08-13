import { decodeCapabilityKey, encodeCapabilityKey } from "./key-material.js";
import { parseSpacePolicy, SpacePolicyValidationError } from "./space-policy.js";
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

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EdgeConfigValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new EdgeConfigValidationError(`${name} contains missing or unknown fields`);
  }
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

export function parseEdgeConfigRefreshReport(value: unknown): EdgeConfigRefreshReportWire {
  const input = object(value, "Edge configuration refresh report");
  exactKeys(input, ["generation"], "Edge configuration refresh report");
  return serializeEdgeConfigRefreshReport(input.generation as number);
}

export function parseEdgeConfigSnapshot(value: unknown): ParsedEdgeConfigSnapshot {
  const input = object(value, "Edge configuration snapshot");
  exactKeys(
    input,
    ["schemaVersion", "generation", "generatedAt", "spaces", "capabilityKeys"],
    "Edge configuration snapshot",
  );
  if (input.schemaVersion !== "v1") {
    throw new EdgeConfigValidationError("schemaVersion must be v1");
  }
  if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 0) {
    throw new EdgeConfigValidationError("generation must be a non-negative safe integer");
  }
  if (typeof input.generatedAt !== "string") {
    throw new EdgeConfigValidationError("generatedAt must be an ISO timestamp");
  }
  const generatedAt = Date.parse(input.generatedAt);
  if (!Number.isFinite(generatedAt) || new Date(generatedAt).toISOString() !== input.generatedAt) {
    throw new EdgeConfigValidationError("generatedAt must be an ISO timestamp");
  }
  if (!Array.isArray(input.spaces)) {
    throw new EdgeConfigValidationError("spaces must be an array");
  }
  const spaces = new Map<string, SpacePolicy>();
  try {
    for (const rawPolicy of input.spaces) {
      const policy = parseSpacePolicy(rawPolicy);
      if (spaces.has(policy.id)) throw new EdgeConfigValidationError("Space IDs must be unique");
      spaces.set(policy.id, policy);
    }
  } catch (error) {
    if (error instanceof SpacePolicyValidationError) {
      throw new EdgeConfigValidationError("a Space policy is invalid");
    }
    throw error;
  }
  const rawRegistry = object(input.capabilityKeys, "capabilityKeys");
  const capabilityKeys = new Map<string, ReadonlyMap<string, Uint8Array>>();
  for (const [spaceId, rawKeys] of Object.entries(rawRegistry)) {
    if (!spaces.has(spaceId)) {
      throw new EdgeConfigValidationError("capabilityKeys contains an unknown Space");
    }
    const keyRecord = object(rawKeys, `capabilityKeys.${spaceId}`);
    const keys = new Map<string, Uint8Array>();
    for (const [keyId, encoded] of Object.entries(keyRecord)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(keyId) || typeof encoded !== "string") {
        throw new EdgeConfigValidationError("a Capability Key entry is invalid");
      }
      try {
        keys.set(keyId, decodeCapabilityKey(encoded));
      } catch {
        throw new EdgeConfigValidationError("a Capability Key entry is invalid");
      }
    }
    capabilityKeys.set(spaceId, keys);
  }
  for (const spaceId of spaces.keys())
    capabilityKeys.set(spaceId, capabilityKeys.get(spaceId) ?? new Map());
  return Object.freeze({
    schemaVersion: "v1",
    generation: input.generation as number,
    generatedAt,
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
