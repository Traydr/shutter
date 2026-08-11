import { parseSpacePolicy, type SpacePolicy } from "@shutter/protocol";
import {
  apiTokenDisplayPrefix,
  apiTokenHash,
  apiTokenMatches,
  createApiToken,
  createCapabilityKey,
  encodeCapabilityKey,
  validateCapabilityKeyId,
} from "./credentials.js";
import type {
  ApiTokenSummary,
  CapabilityKeySummary,
  EdgeSpaceSnapshot,
  IssuedApiToken,
  IssuedCapabilityKey,
  RegistryMutation,
  SpacePolicyUpdate,
  SpaceRecord,
  SpaceRegistry,
} from "./registry.js";
import { SpaceRegistryError } from "./registry.js";

interface StoredApiToken extends ApiTokenSummary {
  hash: string;
}

interface StoredCapabilityKey extends CapabilityKeySummary {
  key: Uint8Array;
}

function copySpace(record: SpaceRecord): SpaceRecord {
  return {
    ...record,
    policy: parseSpacePolicy(record.policy),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    ...(record.decommissionedAt === undefined
      ? {}
      : { decommissionedAt: new Date(record.decommissionedAt) }),
  };
}

function apiSummary(value: StoredApiToken): ApiTokenSummary {
  return {
    id: value.id,
    label: value.label,
    displayPrefix: value.displayPrefix,
    createdAt: new Date(value.createdAt),
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: new Date(value.lastUsedAt) }),
    ...(value.revokedAt === undefined ? {} : { revokedAt: new Date(value.revokedAt) }),
  };
}

function keySummary(value: StoredCapabilityKey): CapabilityKeySummary {
  return {
    id: value.id,
    keyId: value.keyId,
    acceptedAt: new Date(value.acceptedAt),
    ...(value.disabledAt === undefined ? {} : { disabledAt: new Date(value.disabledAt) }),
  };
}

export class MemorySpaceRegistry implements SpaceRegistry {
  readonly #spaces = new Map<string, SpaceRecord>();
  readonly #tokens = new Map<string, StoredApiToken[]>();
  readonly #keys = new Map<string, StoredCapabilityKey[]>();
  readonly #now: () => Date;
  #generation = 0;
  #generatedAt: Date;
  #nextTokenId = 1;
  #nextKeyId = 1;

  constructor(options: { now?: () => Date; spaces?: readonly SpacePolicy[] } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#generatedAt = this.#now();
    for (const policy of options.spaces ?? []) {
      const now = this.#now();
      const parsed = parseSpacePolicy(policy);
      this.#spaces.set(parsed.id, {
        policy: parsed,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async getActiveSpacePolicy(spaceId: string): Promise<SpacePolicy | undefined> {
    const record = this.#spaces.get(spaceId);
    return record?.status === "active" ? parseSpacePolicy(record.policy) : undefined;
  }

  async listSpaces(): Promise<readonly SpaceRecord[]> {
    return [...this.#spaces.values()].map(copySpace);
  }

  async loadEdgeSnapshot(): Promise<EdgeSpaceSnapshot> {
    const spaces = [...this.#spaces.values()]
      .filter((record) => record.status === "active")
      .map((record) => parseSpacePolicy(record.policy));
    const capabilityKeys = new Map<string, ReadonlyMap<string, Uint8Array>>();
    for (const space of spaces) {
      const keys = new Map<string, Uint8Array>();
      for (const key of this.#keys.get(space.id) ?? []) {
        if (key.disabledAt === undefined) keys.set(key.keyId, Uint8Array.from(key.key));
      }
      capabilityKeys.set(space.id, keys);
    }
    return {
      schemaVersion: "v1",
      generation: this.#generation,
      generatedAt: new Date(this.#generatedAt),
      spaces,
      capabilityKeys,
    };
  }

  async createSpace(policy: SpacePolicy): Promise<RegistryMutation<SpaceRecord>> {
    const parsed = parseSpacePolicy(policy);
    if (this.#spaces.has(parsed.id)) {
      throw new SpaceRegistryError("conflict", "the Space public identifier is already reserved");
    }
    const now = this.#now();
    const record: SpaceRecord = {
      policy: parsed,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.#spaces.set(parsed.id, record);
    return this.#mutation(copySpace(record));
  }

  async editSpace(
    spaceId: string,
    update: SpacePolicyUpdate,
  ): Promise<RegistryMutation<SpaceRecord>> {
    const current = this.#activeSpace(spaceId);
    const policy = parseSpacePolicy({
      ...update,
      id: current.policy.id,
      routeClass: current.policy.routeClass,
    });
    const record: SpaceRecord = { ...current, policy, updatedAt: this.#now() };
    this.#spaces.set(spaceId, record);
    return this.#mutation(copySpace(record));
  }

  async decommissionSpace(spaceId: string): Promise<RegistryMutation<SpaceRecord>> {
    const current = this.#activeSpace(spaceId);
    const now = this.#now();
    const record: SpaceRecord = {
      ...current,
      status: "decommissioned",
      updatedAt: now,
      decommissionedAt: now,
    };
    this.#spaces.set(spaceId, record);
    return this.#mutation(copySpace(record));
  }

  async issueApiToken(
    spaceId: string,
    label: string,
    suppliedToken?: string,
  ): Promise<RegistryMutation<IssuedApiToken>> {
    this.#activeSpace(spaceId);
    if (label.trim().length === 0 || label.length > 128) {
      throw new SpaceRegistryError("invalid", "an API token label is required");
    }
    const token = suppliedToken ?? createApiToken();
    const hash = apiTokenHash(token);
    if ([...this.#tokens.values()].flat().some((candidate) => candidate.hash === hash)) {
      throw new SpaceRegistryError("conflict", "the API token already exists");
    }
    const value: StoredApiToken = {
      id: this.#nextTokenId++,
      label: label.trim(),
      hash,
      displayPrefix: apiTokenDisplayPrefix(token),
      createdAt: this.#now(),
    };
    this.#tokens.set(spaceId, [...(this.#tokens.get(spaceId) ?? []), value]);
    return this.#mutation({ ...apiSummary(value), token });
  }

  async verifyApiToken(spaceId: string, token: string): Promise<boolean> {
    if ((await this.getActiveSpacePolicy(spaceId)) === undefined) return false;
    let match: StoredApiToken | undefined;
    try {
      match = (this.#tokens.get(spaceId) ?? []).find(
        (candidate) => candidate.revokedAt === undefined && apiTokenMatches(token, candidate.hash),
      );
    } catch (error) {
      if (error instanceof SpaceRegistryError && error.code === "invalid") return false;
      throw error;
    }
    if (match === undefined) return false;
    match.lastUsedAt = this.#now();
    return true;
  }

  async listApiTokens(spaceId: string): Promise<readonly ApiTokenSummary[]> {
    this.#space(spaceId);
    return (this.#tokens.get(spaceId) ?? []).map(apiSummary);
  }

  async revokeApiToken(
    spaceId: string,
    tokenId: number,
  ): Promise<RegistryMutation<ApiTokenSummary>> {
    this.#activeSpace(spaceId);
    const token = (this.#tokens.get(spaceId) ?? []).find((candidate) => candidate.id === tokenId);
    if (token === undefined)
      throw new SpaceRegistryError("not_found", "the API token does not exist");
    token.revokedAt ??= this.#now();
    return this.#mutation(apiSummary(token));
  }

  async addCapabilityKey(
    spaceId: string,
    keyId: string,
    suppliedKey?: Uint8Array,
  ): Promise<RegistryMutation<IssuedCapabilityKey>> {
    this.#activeSpace(spaceId);
    validateCapabilityKeyId(keyId);
    if ((this.#keys.get(spaceId) ?? []).some((candidate) => candidate.keyId === keyId)) {
      throw new SpaceRegistryError("conflict", "the Capability Key identifier already exists");
    }
    const key = suppliedKey === undefined ? createCapabilityKey() : Uint8Array.from(suppliedKey);
    const encoded = encodeCapabilityKey(key);
    const value: StoredCapabilityKey = {
      id: this.#nextKeyId++,
      keyId,
      key,
      acceptedAt: this.#now(),
    };
    this.#keys.set(spaceId, [...(this.#keys.get(spaceId) ?? []), value]);
    return this.#mutation({ ...keySummary(value), key: encoded });
  }

  async listCapabilityKeys(spaceId: string): Promise<readonly CapabilityKeySummary[]> {
    this.#space(spaceId);
    return (this.#keys.get(spaceId) ?? []).map(keySummary);
  }

  async disableCapabilityKey(
    spaceId: string,
    keyId: string,
  ): Promise<RegistryMutation<CapabilityKeySummary>> {
    this.#activeSpace(spaceId);
    const key = (this.#keys.get(spaceId) ?? []).find((candidate) => candidate.keyId === keyId);
    if (key === undefined) {
      throw new SpaceRegistryError("not_found", "the Capability Key does not exist");
    }
    key.disabledAt ??= this.#now();
    return this.#mutation(keySummary(key));
  }

  #space(spaceId: string): SpaceRecord {
    const record = this.#spaces.get(spaceId);
    if (record === undefined) throw new SpaceRegistryError("not_found", "the Space does not exist");
    return record;
  }

  #activeSpace(spaceId: string): SpaceRecord {
    const record = this.#space(spaceId);
    if (record.status !== "active") {
      throw new SpaceRegistryError("not_found", "the active Space does not exist");
    }
    return record;
  }

  #mutation<T>(value: T): RegistryMutation<T> {
    this.#generation += 1;
    this.#generatedAt = this.#now();
    return { generation: this.#generation, value };
  }
}
