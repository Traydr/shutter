import {
  normalizeSourceOriginPathPrefix,
  parseSpacePolicy,
  type SpacePolicy,
} from "@shutter/protocol";
import type { Pool, PoolClient } from "pg";
import { transaction } from "../db/transaction.js";
import {
  apiTokenDisplayPrefix,
  apiTokenHash,
  createApiToken,
  createCapabilityKey,
  encodeCapabilityKey,
  isWellFormedApiToken,
  validateApiToken,
  validateCapabilityKeyId,
} from "./credentials.js";
import type { CapabilityKeyEncryption } from "./encryption.js";
import { loadSpaceRecords } from "./postgres-policy.js";
import type {
  ActiveSpaceAuthorization,
  ApiTokenSummary,
  CapabilityKeySummary,
  EdgeSpaceSnapshot,
  IssuedApiToken,
  IssuedCapabilityKey,
  RegistryMutation,
  SpacePolicyUpdate,
  SpaceRecord,
  SpaceRegistry,
  SpaceRegistryTransaction,
} from "./registry.js";
import { SpaceRegistryError } from "./registry.js";

interface GenerationRow {
  generation: number;
  updated_at: Date;
}

interface ApiTokenRow {
  id: number;
  label: string;
  display_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

interface CapabilityKeyRow {
  id: number;
  key_id: string;
  accepted_at: Date;
  disabled_at: Date | null;
}

interface SealedCapabilityKeyRow {
  key_id: string;
  sealed_nonce: string;
  sealed_key: string;
}

const API_TOKEN_COLUMNS = "id, label, display_prefix, created_at, last_used_at, revoked_at";
const CAPABILITY_KEY_COLUMNS = "id, key_id, accepted_at, disabled_at";

function apiTokenSummary(row: ApiTokenRow): ApiTokenSummary {
  return {
    id: row.id,
    label: row.label,
    displayPrefix: row.display_prefix,
    createdAt: row.created_at,
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

function capabilityKeySummary(row: CapabilityKeyRow): CapabilityKeySummary {
  return {
    id: row.id,
    keyId: row.key_id,
    acceptedAt: row.accepted_at,
    ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
  };
}

async function bumpGeneration(client: PoolClient, now: Date): Promise<number> {
  const result = await client.query<GenerationRow>(
    `update space_registry_metadata
     set generation = generation + 1, updated_at = $1
     where id = 1 returning generation, updated_at`,
    [now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Space Registry metadata is not initialized");
  return row.generation;
}

async function lockActiveSpace(client: PoolClient, spaceId: string): Promise<number> {
  const result = await client.query<{ id: number }>(
    `select id from spaces where space_id = $1 and status = 'active' for update`,
    [spaceId],
  );
  const recordId = result.rows[0]?.id;
  if (recordId === undefined) {
    throw new SpaceRegistryError("not_found", "the active Space does not exist");
  }
  return recordId;
}

async function insertPolicyChildren(
  client: PoolClient,
  recordId: number,
  policy: SpacePolicy,
): Promise<void> {
  for (const rule of policy.allowedSourceOrigins) {
    await client.query(
      `insert into space_source_origins (space_id, origin, path_prefix) values ($1, $2, $3)`,
      [recordId, rule.origin, normalizeSourceOriginPathPrefix(rule.pathPrefix)],
    );
  }
  for (const resolver of policy.resolvers) {
    await client.query(
      `insert into space_resolvers
        (space_id, resolver_id, resolver_type, allowed_project_ids)
       values ($1, $2, $3, $4)`,
      [recordId, resolver.id, resolver.type, resolver.allowedProjectIds],
    );
  }
}

function mapConflict(error: unknown, message: string): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  ) {
    throw new SpaceRegistryError("conflict", message);
  }
  throw error;
}

export class PostgresSpaceRegistry implements SpaceRegistry {
  readonly #pool: Pool;
  readonly #encryption: CapabilityKeyEncryption | undefined;
  readonly #now: () => Date;
  readonly #transactionClient: PoolClient | undefined;

  constructor(
    pool: Pool,
    options: {
      encryption?: CapabilityKeyEncryption;
      now?: () => Date;
      transactionClient?: PoolClient;
    } = {},
  ) {
    this.#pool = pool;
    this.#encryption = options.encryption;
    this.#now = options.now ?? (() => new Date());
    this.#transactionClient = options.transactionClient;
  }

  async withTransaction<T>(work: (registry: SpaceRegistryTransaction) => Promise<T>): Promise<T> {
    if (this.#transactionClient !== undefined) return work(this);
    return transaction(this.#pool, (client) =>
      work(
        new PostgresSpaceRegistry(this.#pool, {
          ...(this.#encryption === undefined ? {} : { encryption: this.#encryption }),
          now: this.#now,
          transactionClient: client,
        }),
      ),
    );
  }

  async getActiveSpacePolicy(spaceId: string): Promise<SpacePolicy | undefined> {
    const [record] = await this.#read((client) =>
      loadSpaceRecords(client, { activeOnly: true, spaceId }),
    );
    return record?.value.policy;
  }

  async getActiveSpaceAuthorization(
    spaceId: string,
  ): Promise<ActiveSpaceAuthorization | undefined> {
    return this.#read(async (client) => {
      const [record] = await loadSpaceRecords(client, { activeOnly: true, spaceId });
      if (record === undefined) return undefined;
      const encryption = this.#capabilityKeyEncryption();
      const result = await client.query<SealedCapabilityKeyRow>(
        `select key_id, sealed_nonce, sealed_key
         from space_capability_keys
         where space_id = $1 and disabled_at is null
         order by id`,
        [record.recordId],
      );
      const capabilityKeys = new Map<string, Uint8Array>();
      for (const key of result.rows) {
        capabilityKeys.set(
          key.key_id,
          encryption.open(spaceId, key.key_id, {
            nonce: key.sealed_nonce,
            ciphertext: key.sealed_key,
          }),
        );
      }
      return { policy: record.value.policy, capabilityKeys };
    });
  }

  async listSpaces(): Promise<readonly SpaceRecord[]> {
    const records = await this.#read((client) => loadSpaceRecords(client));
    return records.map((record) => record.value);
  }

  async loadEdgeSnapshot(): Promise<EdgeSpaceSnapshot> {
    return this.#read((client) => this.#loadEdgeSnapshot(client));
  }

  async createSpace(policy: SpacePolicy): Promise<RegistryMutation<SpaceRecord>> {
    const parsed = parseSpacePolicy(policy);
    try {
      return await this.#write(async (client) => {
        const now = this.#now();
        const inserted = await client.query<{ id: number }>(
          `insert into spaces
            (space_id, route_class, status, qualities, default_quality, created_at, updated_at)
           values ($1, $2, 'active', $3, $4, $5, $5) returning id`,
          [parsed.id, parsed.routeClass, parsed.qualities, parsed.defaultQuality, now],
        );
        const recordId = inserted.rows[0]?.id;
        if (recordId === undefined)
          throw new Error("the Space insert did not return an identifier");
        await insertPolicyChildren(client, recordId, parsed);
        const generation = await bumpGeneration(client, now);
        const value: SpaceRecord = {
          policy: parsed,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        return { generation, value };
      });
    } catch (error) {
      return mapConflict(error, "the Space public identifier is already reserved");
    }
  }

  async editSpace(
    spaceId: string,
    update: SpacePolicyUpdate,
  ): Promise<RegistryMutation<SpaceRecord>> {
    return this.#mutate(spaceId, async (client, recordId, now) => {
      const [stored] = await loadSpaceRecords(client, { spaceId });
      if (stored === undefined) throw new Error("the locked Space could not be loaded");
      const policy = parseSpacePolicy({
        ...update,
        id: stored.value.policy.id,
        routeClass: stored.value.policy.routeClass,
      });
      await client.query(
        `update spaces set qualities = $2, default_quality = $3, updated_at = $4 where id = $1`,
        [recordId, policy.qualities, policy.defaultQuality, now],
      );
      await client.query(`delete from space_source_origins where space_id = $1`, [recordId]);
      await client.query(`delete from space_resolvers where space_id = $1`, [recordId]);
      await insertPolicyChildren(client, recordId, policy);
      return { ...stored.value, policy, updatedAt: now };
    });
  }

  async decommissionSpace(spaceId: string): Promise<RegistryMutation<SpaceRecord>> {
    return this.#mutate(spaceId, async (client, recordId, now) => {
      const [stored] = await loadSpaceRecords(client, { spaceId });
      if (stored === undefined) throw new Error("the locked Space could not be loaded");
      await client.query(
        `update spaces set status = 'decommissioned', decommissioned_at = $2, updated_at = $2
         where id = $1`,
        [recordId, now],
      );
      return {
        ...stored.value,
        status: "decommissioned" as const,
        decommissionedAt: now,
        updatedAt: now,
      };
    });
  }

  async issueApiToken(
    spaceId: string,
    label: string,
    suppliedToken?: string,
  ): Promise<RegistryMutation<IssuedApiToken>> {
    try {
      return await this.#mutate(spaceId, async (client, recordId, now) => {
        if (label.trim().length === 0 || label.length > 128) {
          throw new SpaceRegistryError("invalid", "an API token label is required");
        }
        if (suppliedToken !== undefined) validateApiToken(suppliedToken);
        const token = suppliedToken ?? createApiToken();
        const inserted = await client.query<ApiTokenRow>(
          `insert into space_api_tokens
            (space_id, label, token_hash, display_prefix, created_at)
           values ($1, $2, $3, $4, $5)
           returning ${API_TOKEN_COLUMNS}`,
          [recordId, label.trim(), apiTokenHash(token), apiTokenDisplayPrefix(token), now],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error("the API token insert returned no row");
        return { ...apiTokenSummary(row), token };
      });
    } catch (error) {
      return mapConflict(error, "the API token already exists");
    }
  }

  async verifyApiToken(spaceId: string, token: string): Promise<boolean> {
    if (!isWellFormedApiToken(token)) return false;
    const database = this.#transactionClient ?? this.#pool;
    // The unique index on token_hash makes the equality filter authoritative:
    // at most one row can match, so a returned row is the verification.
    const result = await database.query<{ id: number }>(
      `select tokens.id
       from space_api_tokens tokens
       join spaces on spaces.id = tokens.space_id
       where spaces.space_id = $1 and spaces.status = 'active'
         and tokens.token_hash = $2 and tokens.revoked_at is null`,
      [spaceId, apiTokenHash(token)],
    );
    const match = result.rows[0];
    if (match === undefined) return false;
    void database
      .query(`update space_api_tokens set last_used_at = $2 where id = $1 and revoked_at is null`, [
        match.id,
        this.#now(),
      ])
      .catch(() => undefined);
    return true;
  }

  async listApiTokens(spaceId: string): Promise<readonly ApiTokenSummary[]> {
    return this.#read(async (client) => {
      const [space] = await loadSpaceRecords(client, { spaceId });
      if (space === undefined) {
        throw new SpaceRegistryError("not_found", "the Space does not exist");
      }
      const result = await client.query<ApiTokenRow>(
        `select ${API_TOKEN_COLUMNS}
         from space_api_tokens where space_id = $1 order by id`,
        [space.recordId],
      );
      return result.rows.map(apiTokenSummary);
    });
  }

  async revokeApiToken(
    spaceId: string,
    tokenId: number,
  ): Promise<RegistryMutation<ApiTokenSummary>> {
    return this.#mutate(spaceId, async (client, recordId, now) => {
      const result = await client.query<ApiTokenRow>(
        `update space_api_tokens set revoked_at = coalesce(revoked_at, $3)
         where id = $1 and space_id = $2
         returning ${API_TOKEN_COLUMNS}`,
        [tokenId, recordId, now],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new SpaceRegistryError("not_found", "the API token does not exist");
      }
      return apiTokenSummary(row);
    });
  }

  async addCapabilityKey(
    spaceId: string,
    keyId: string,
    suppliedKey?: Uint8Array,
  ): Promise<RegistryMutation<IssuedCapabilityKey>> {
    try {
      return await this.#mutate(spaceId, async (client, recordId, now) => {
        validateCapabilityKeyId(keyId);
        const encryption = this.#capabilityKeyEncryption();
        const key =
          suppliedKey === undefined ? createCapabilityKey() : Uint8Array.from(suppliedKey);
        const encoded = encodeCapabilityKey(key);
        const sealed = encryption.seal(spaceId, keyId, key);
        const result = await client.query<CapabilityKeyRow>(
          `insert into space_capability_keys
            (space_id, key_id, sealed_nonce, sealed_key, accepted_at)
           values ($1, $2, $3, $4, $5)
           returning ${CAPABILITY_KEY_COLUMNS}`,
          [recordId, keyId, sealed.nonce, sealed.ciphertext, now],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("the Capability Key insert returned no row");
        return { ...capabilityKeySummary(row), key: encoded };
      });
    } catch (error) {
      return mapConflict(error, "the Capability Key identifier already exists");
    }
  }

  async listCapabilityKeys(spaceId: string): Promise<readonly CapabilityKeySummary[]> {
    return this.#read(async (client) => {
      const [space] = await loadSpaceRecords(client, { spaceId });
      if (space === undefined) {
        throw new SpaceRegistryError("not_found", "the Space does not exist");
      }
      const result = await client.query<CapabilityKeyRow>(
        `select ${CAPABILITY_KEY_COLUMNS}
         from space_capability_keys where space_id = $1 order by id`,
        [space.recordId],
      );
      return result.rows.map(capabilityKeySummary);
    });
  }

  async disableCapabilityKey(
    spaceId: string,
    keyId: string,
  ): Promise<RegistryMutation<CapabilityKeySummary>> {
    return this.#mutate(spaceId, async (client, recordId, now) => {
      const result = await client.query<CapabilityKeyRow>(
        `update space_capability_keys set disabled_at = coalesce(disabled_at, $3)
         where space_id = $1 and key_id = $2
         returning ${CAPABILITY_KEY_COLUMNS}`,
        [recordId, keyId, now],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new SpaceRegistryError("not_found", "the Capability Key does not exist");
      }
      return capabilityKeySummary(row);
    });
  }

  /**
   * Every Space-scoped mutation runs as: one transaction, a lock on the active
   * Space row, one clock reading, the statements, then exactly one generation
   * bump. The helper owns that skeleton so a mutation cannot forget the bump
   * and leave the Edge snapshot stale.
   */
  async #mutate<T>(
    spaceId: string,
    work: (client: PoolClient, recordId: number, now: Date) => Promise<T>,
  ): Promise<RegistryMutation<T>> {
    return this.#write(async (client) => {
      const recordId = await lockActiveSpace(client, spaceId);
      const now = this.#now();
      const value = await work(client, recordId, now);
      const generation = await bumpGeneration(client, now);
      return { generation, value };
    });
  }

  #capabilityKeyEncryption(): CapabilityKeyEncryption {
    if (this.#encryption === undefined) {
      throw new SpaceRegistryError("unavailable", "Capability Key encryption is not configured");
    }
    return this.#encryption;
  }

  #write<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.#transactionClient === undefined
      ? transaction(this.#pool, work)
      : work(this.#transactionClient);
  }

  /**
   * A policy read spans several tables. Outside a caller-owned transaction it
   * runs inside one repeatable-read snapshot so no concurrent edit can split
   * what the caller observes.
   */
  #read<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.#transactionClient === undefined
      ? transaction(this.#pool, work, { mode: "repeatable read read only" })
      : work(this.#transactionClient);
  }

  async #loadEdgeSnapshot(client: PoolClient): Promise<EdgeSpaceSnapshot> {
    const encryption = this.#capabilityKeyEncryption();
    const metadata = await client.query<GenerationRow>(
      `select generation, updated_at from space_registry_metadata where id = 1`,
    );
    const generation = metadata.rows[0];
    if (generation === undefined) throw new Error("Space Registry metadata is not initialized");
    const records = await loadSpaceRecords(client, { activeOnly: true });
    const keys = await client.query<SealedCapabilityKeyRow & { public_space_id: string }>(
      `select spaces.space_id as public_space_id, keys.key_id, keys.sealed_nonce, keys.sealed_key
       from space_capability_keys keys
       join spaces on spaces.id = keys.space_id
       where spaces.status = 'active' and keys.disabled_at is null
       order by keys.id`,
    );
    const capabilityKeys = new Map<string, Map<string, Uint8Array>>();
    for (const record of records) capabilityKeys.set(record.value.policy.id, new Map());
    let undecryptable = 0;
    for (const key of keys.rows) {
      const spaceKeys = capabilityKeys.get(key.public_space_id);
      if (spaceKeys === undefined) {
        throw new Error("a Capability Key references a Space missing from the snapshot");
      }
      try {
        spaceKeys.set(
          key.key_id,
          encryption.open(key.public_space_id, key.key_id, {
            nonce: key.sealed_nonce,
            ciphertext: key.sealed_key,
          }),
        );
      } catch {
        // One undecryptable row degrades that key alone: capabilities signed
        // with it fail verification at the Edge, which is the same outcome as
        // excluding it, without taking down every Space.
        undecryptable += 1;
      }
    }
    if (undecryptable > 0) {
      console.error(
        `space registry: excluded ${undecryptable} undecryptable Capability Key(s) from the Edge snapshot`,
      );
    }
    return {
      schemaVersion: "v1",
      generation: generation.generation,
      registryUpdatedAt: generation.updated_at,
      spaces: records.map((record) => record.value.policy),
      capabilityKeys,
    };
  }
}
