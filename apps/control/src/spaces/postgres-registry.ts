import {
  type JsonObject,
  normalizeSourceOriginPathPrefix,
  parseSpacePolicy,
  type SourceResolverPolicy,
  type SpacePolicy,
} from "@shutter/protocol";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
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
import {
  loadSpaceRecords,
  type RegistryDatabase,
  SEALED_CAPABILITY_KEYS_COLUMN,
  type SealedCapabilityKeyRow,
  SPACE_POLICY_WITH_KEYS_JSON,
  SPACE_RECORD_COLUMNS,
  sealedCapabilityKeysSchema,
  spacePolicyFromRow,
  spacePolicyRowSchema,
  spaceRecordRowSchema,
} from "./postgres-policy.js";
import type {
  ActiveResolverRead,
  ActiveSpaceAuthorization,
  ApiTokenSummary,
  CapabilityKeySummary,
  EdgeSpaceSnapshot,
  IssuedApiToken,
  IssuedCapabilityKey,
  RegistryGeneration,
  RegistryMutation,
  ResolverChange,
  ResolverCredential,
  ResolverCredentialInput,
  ResolverCredentialRead,
  ResolverCredentialSummary,
  ResolverIdentity,
  SpacePolicyUpdate,
  SpaceRecord,
  SpaceRegistry,
  SpaceRegistryTransaction,
  SpaceRequest,
  SpaceRequestAuthorization,
  SpaceRequestGrant,
} from "./registry.js";
import {
  API_TOKEN_USE_RESOLUTION_MS,
  apiTokenUseIsStale,
  applyResolverChange,
  planResolverCredentials,
  rejectRetiredResolvers,
  SpaceRegistryError,
} from "./registry.js";

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

interface ResolverCredentialRow {
  resolver_id: string;
  credential_access_key_id: string;
  sealed_credential_nonce: string;
  sealed_credential: string;
  credential_updated_at: Date;
}

/** A credential as it is written: sealed, so a carry-over never opens it. */
interface SealedCredentialColumns {
  accessKeyId: string;
  nonce: string;
  ciphertext: string;
  updatedAt: Date;
}

const RESOLVER_CREDENTIAL_COLUMNS =
  "resolver_id, credential_access_key_id, sealed_credential_nonce, sealed_credential, credential_updated_at";

function sealedColumns(row: ResolverCredentialRow): SealedCredentialColumns {
  return {
    accessKeyId: row.credential_access_key_id,
    nonce: row.sealed_credential_nonce,
    ciphertext: row.sealed_credential,
    updatedAt: row.credential_updated_at,
  };
}

/** The AAD scope of a sealed resolver credential: the row and its access key ID, so neither can be swapped. */
function credentialScope(resolverId: string, accessKeyId: string): string {
  return `resolver:${resolverId}:${accessKeyId}`;
}

/** The kind-specific public fields of a resolver, as the `config` column stores them. */
function resolverConfig(resolver: SourceResolverPolicy): JsonObject {
  switch (resolver.type) {
    case "template": {
      const placeholders: Record<string, JsonObject> = {};
      for (const [name, placeholder] of Object.entries(resolver.placeholders)) {
        placeholders[name] =
          placeholder.allowed === undefined ? {} : { allowed: [...placeholder.allowed] };
      }
      return { url: resolver.url, placeholders };
    }
    case "s3":
      return {
        endpoint: resolver.endpoint,
        region: resolver.region,
        bucket: resolver.bucket,
        pathStyle: resolver.pathStyle,
        keyTemplate: resolver.keyTemplate,
      };
    case "uploadthing":
      throw new SpaceRegistryError(
        "invalid",
        "the uploadthing resolver kind can no longer be stored",
      );
  }
}

const API_TOKEN_COLUMNS = "id, label, display_prefix, created_at, last_used_at, revoked_at";
const CAPABILITY_KEY_COLUMNS = "id, key_id, accepted_at, disabled_at";

function apiTokenSummary(row: ApiTokenRow): ApiTokenSummary {
  const summary: ApiTokenSummary = {
    id: row.id,
    label: row.label,
    displayPrefix: row.display_prefix,
    createdAt: row.created_at,
  };
  if (row.last_used_at !== null) summary.lastUsedAt = row.last_used_at;
  if (row.revoked_at !== null) summary.revokedAt = row.revoked_at;
  return summary;
}

function capabilityKeySummary(row: CapabilityKeyRow): CapabilityKeySummary {
  const summary: CapabilityKeySummary = {
    id: row.id,
    keyId: row.key_id,
    acceptedAt: row.accepted_at,
  };
  if (row.disabled_at !== null) summary.disabledAt = row.disabled_at;
  return summary;
}

/** A timestamp inside a JSON aggregate, which Postgres renders as ISO 8601 with an offset. */
const jsonTimestampSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const generationRowSchema = z.object({ generation: z.int().nonnegative(), updated_at: z.date() });

/** An application request's read: the active Space and the one live token whose hash matched, if any. */
const authorizationRowSchema = spaceRecordRowSchema.extend({
  token_id: z.int().nullable(),
  token_last_used_at: z.date().nullable(),
});

type AuthorizationRow = z.infer<typeof authorizationRowSchema>;

const keyedAuthorizationRowSchema = authorizationRowSchema.extend({
  capability_keys: sealedCapabilityKeysSchema,
});

const keyedSpaceRowSchema = spaceRecordRowSchema.extend({
  capability_keys: sealedCapabilityKeysSchema,
});

const sealedResolverCredentialSchema = z.object({
  access_key_id: z.string(),
  nonce: z.string(),
  ciphertext: z.string(),
});

type SealedResolverCredential = z.infer<typeof sealedResolverCredentialSchema>;

/** One sealed resolver credential as a JSON object, for a `space_resolvers c` row. */
const SEALED_RESOLVER_CREDENTIAL_JSON = `json_build_object('access_key_id', c.credential_access_key_id,
  'nonce', c.sealed_credential_nonce, 'ciphertext', c.sealed_credential)`;

const resolverReadRowSchema = spaceRecordRowSchema.extend({
  credential: sealedResolverCredentialSchema.nullable(),
});

const credentialRowSchema = z.object({ credential: sealedResolverCredentialSchema });

const tokenUseRowSchema = z.object({ id: z.int(), last_used_at: z.date().nullable() });

const edgeSnapshotRowSchema = generationRowSchema.extend({
  spaces: z.array(spacePolicyRowSchema.extend({ capability_keys: sealedCapabilityKeysSchema })),
});

const apiTokensRowSchema = z.object({
  tokens: z.array(
    z.object({
      id: z.int(),
      label: z.string(),
      display_prefix: z.string(),
      created_at: jsonTimestampSchema,
      last_used_at: jsonTimestampSchema.nullable(),
      revoked_at: jsonTimestampSchema.nullable(),
    }),
  ),
});

const capabilityKeysRowSchema = z.object({
  keys: z.array(
    z.object({
      id: z.int(),
      key_id: z.string(),
      accepted_at: jsonTimestampSchema,
      disabled_at: jsonTimestampSchema.nullable(),
    }),
  ),
});

const resolverCredentialsRowSchema = z.object({
  credentials: z.array(
    z.object({
      resolver_id: z.string(),
      access_key_id: z.string(),
      updated_at: jsonTimestampSchema,
    }),
  ),
});

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

async function lockSpace(
  client: PoolClient,
  spaceId: string,
  options: { activeOnly: boolean },
): Promise<number> {
  const result = await client.query<{ id: number }>(
    options.activeOnly
      ? `select id from spaces where space_id = $1 and status = 'active' for update`
      : `select id from spaces where space_id = $1 for update`,
    [spaceId],
  );
  const recordId = result.rows[0]?.id;
  if (recordId === undefined) {
    throw new SpaceRegistryError(
      "not_found",
      options.activeOnly ? "the active Space does not exist" : "the Space does not exist",
    );
  }
  return recordId;
}

async function insertPolicyChildren(
  client: PoolClient,
  recordId: number,
  policy: SpacePolicy,
  credentials: ReadonlyMap<string, SealedCredentialColumns>,
): Promise<void> {
  for (const rule of policy.allowedSourceOrigins) {
    await client.query(
      `insert into space_source_origins (space_id, origin, path_prefix) values ($1, $2, $3)`,
      [recordId, rule.origin, normalizeSourceOriginPathPrefix(rule.pathPrefix)],
    );
  }
  for (const resolver of policy.resolvers) {
    const config = resolverConfig(resolver);
    const credential = credentials.get(resolver.id);
    if (resolver.type !== "s3" || credential === undefined) {
      await client.query(
        `insert into space_resolvers (space_id, resolver_id, resolver_type, config)
         values ($1, $2, $3, $4)`,
        [recordId, resolver.id, resolver.type, config],
      );
      continue;
    }
    await client.query(
      `insert into space_resolvers
        (space_id, resolver_id, resolver_type, config, credential_access_key_id,
         sealed_credential_nonce, sealed_credential, credential_updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        recordId,
        resolver.id,
        resolver.type,
        config,
        credential.accessKeyId,
        credential.nonce,
        credential.ciphertext,
        credential.updatedAt,
      ],
    );
  }
}

/**
 * Opens one Space's sealed Capability Keys. An undecryptable row is excluded
 * and counted rather than thrown: capabilities signed with that key fail
 * verification, which is the same outcome as excluding it, without failing
 * every other key on the Space. Encryption being unconfigured is a different
 * fault — the caller resolves it before reaching here so that stays
 * fail-closed.
 */
interface OpenedCapabilityKeys {
  keys: Map<string, Uint8Array>;
  /** Rows that were excluded because they could not be opened. */
  undecryptable: number;
}

function openSealedKeys(
  encryption: CapabilityKeyEncryption,
  publicSpaceId: string,
  rows: readonly SealedCapabilityKeyRow[],
): OpenedCapabilityKeys {
  const keys = new Map<string, Uint8Array>();
  let undecryptable = 0;
  for (const row of rows) {
    try {
      keys.set(
        row.key_id,
        encryption.open(publicSpaceId, row.key_id, {
          nonce: row.sealed_nonce,
          ciphertext: row.sealed_key,
        }),
      );
    } catch {
      undecryptable += 1;
    }
  }
  return { keys, undecryptable };
}

/** Which registry read excluded undecryptable Capability Keys. */
export type CapabilityKeyReadScope = "space_authorization" | "edge_snapshot";

/**
 * Receives the count of Capability Keys a read excluded because they could not
 * be opened. The count and scope are the whole message: no identifiers leave
 * the registry through this path.
 */
export type UndecryptableKeyReporter = (scope: CapabilityKeyReadScope, count: number) => void;

const defaultUndecryptableKeyReporter: UndecryptableKeyReporter = (scope, count) => {
  console.error(
    `space registry: excluded ${count} undecryptable Capability Key(s) from ${scope.replace("_", " ")}`,
  );
};

/** The one Postgres error field a conflict is recognised by: SQLSTATE 23505, unique_violation. */
const uniqueViolationSchema = z.object({ code: z.literal("23505") });

function mapConflict(cause: unknown, message: string): never {
  if (uniqueViolationSchema.safeParse(cause).success) {
    throw new SpaceRegistryError("conflict", message);
  }
  throw cause;
}

export interface PostgresSpaceRegistryOptions {
  encryption?: CapabilityKeyEncryption;
  now?: () => Date;
  transactionClient?: PoolClient;
  onUndecryptableKeys?: UndecryptableKeyReporter;
}

export class PostgresSpaceRegistry implements SpaceRegistry {
  readonly #pool: Pool;
  readonly #encryption: CapabilityKeyEncryption | undefined;
  readonly #now: () => Date;
  readonly #transactionClient: PoolClient | undefined;
  readonly #reportUndecryptableKeys: UndecryptableKeyReporter;
  /** The last Edge snapshot built outside a transaction; it carries the generation it was read at. */
  #edgeSnapshot: EdgeSpaceSnapshot | undefined;
  /** The rebuild in flight, and the generation the requests waiting on it observed. */
  #edgeSnapshotBuild: { generation: number; snapshot: Promise<EdgeSpaceSnapshot> } | undefined;

  constructor(pool: Pool, options: PostgresSpaceRegistryOptions = {}) {
    this.#pool = pool;
    this.#encryption = options.encryption;
    this.#now = options.now ?? (() => new Date());
    this.#transactionClient = options.transactionClient;
    this.#reportUndecryptableKeys = options.onUndecryptableKeys ?? defaultUndecryptableKeyReporter;
  }

  async withTransaction<T>(work: (registry: SpaceRegistryTransaction) => Promise<T>): Promise<T> {
    if (this.#transactionClient !== undefined) return work(this);
    return transaction(this.#pool, (client) => {
      const options: PostgresSpaceRegistryOptions = {
        now: this.#now,
        transactionClient: client,
        onUndecryptableKeys: this.#reportUndecryptableKeys,
      };
      if (this.#encryption !== undefined) options.encryption = this.#encryption;
      return work(new PostgresSpaceRegistry(this.#pool, options));
    });
  }

  async getSpace(spaceId: string): Promise<SpaceRecord | undefined> {
    const [record] = await loadSpaceRecords(this.#database(), { spaceId });

    return record?.value;
  }

  async getActiveSpacePolicy(spaceId: string): Promise<SpacePolicy | undefined> {
    const [record] = await loadSpaceRecords(this.#database(), { activeOnly: true, spaceId });

    return record?.value.policy;
  }

  async getActiveResolverRead(resolver: ResolverIdentity): Promise<ActiveResolverRead | undefined> {
    const result = await this.#database().query(
      `select ${SPACE_RECORD_COLUMNS},
         (select ${SEALED_RESOLVER_CREDENTIAL_JSON} from space_resolvers c
          where c.space_id = s.id and c.resolver_id = $2 and c.sealed_credential is not null)
           as credential
       from spaces s where s.space_id = $1 and s.status = 'active'`,
      [resolver.spaceId, resolver.resolverId],
    );
    const [row] = result.rows;
    if (row === undefined) return undefined;
    const read = resolverReadRowSchema.parse(row);

    return {
      policy: spacePolicyFromRow(read),
      credential: this.#readResolverCredential(resolver, read.credential),
    };
  }

  async getGeneration(): Promise<RegistryGeneration> {
    const result = await this.#database().query(
      `select generation, updated_at from space_registry_metadata where id = 1`,
    );
    const [row] = result.rows;
    if (row === undefined) throw new Error("Space Registry metadata is not initialized");
    const generation = generationRowSchema.parse(row);

    return { generation: generation.generation, updatedAt: generation.updated_at };
  }

  async getSpaceAuthorization(spaceId: string): Promise<ActiveSpaceAuthorization | undefined> {
    const result = await this.#database().query(
      `select ${SPACE_RECORD_COLUMNS}, ${SEALED_CAPABILITY_KEYS_COLUMN}
       from spaces s where s.space_id = $1`,
      [spaceId],
    );
    const [row] = result.rows;
    if (row === undefined) return undefined;
    const space = keyedSpaceRowSchema.parse(row);

    return {
      policy: spacePolicyFromRow(space),
      capabilityKeys: this.#openCapabilityKeys(spaceId, space.capability_keys),
    };
  }

  async authorizeSpaceRequest(request: SpaceRequest): Promise<SpaceRequestAuthorization> {
    const row = await this.#authorizationRow(request, {
      columns: "",
      schema: authorizationRowSchema,
    });

    return this.#settleAuthorization(row, (space) => ({ policy: spacePolicyFromRow(space) }));
  }

  async authorizeSpaceRequestWithKeys(
    request: SpaceRequest,
  ): Promise<SpaceRequestAuthorization<ActiveSpaceAuthorization>> {
    const row = await this.#authorizationRow(request, {
      columns: `, ${SEALED_CAPABILITY_KEYS_COLUMN}`,
      schema: keyedAuthorizationRowSchema,
    });

    return this.#settleAuthorization(row, (space) => ({
      policy: spacePolicyFromRow(space),
      capabilityKeys: this.#openCapabilityKeys(request.spaceId, space.capability_keys),
    }));
  }

  /**
   * The one statement behind both authorizations: the active Space and the
   * live token whose hash matched, left-joined so a Space without that token
   * still comes back and `missing` stays distinguishable from `unauthorized`.
   */
  async #authorizationRow<Row extends AuthorizationRow>(
    request: SpaceRequest,
    read: { columns: string; schema: z.ZodType<Row> },
  ): Promise<Row | undefined> {
    const tokenHash =
      request.token !== undefined && isWellFormedApiToken(request.token)
        ? apiTokenHash(request.token)
        : null;
    // The unique index on token_hash makes the equality filter authoritative:
    // at most one row can match, so the join cannot multiply the Space row.
    const result = await this.#database().query(
      `select ${SPACE_RECORD_COLUMNS}${read.columns},
         tokens.id as token_id, tokens.last_used_at as token_last_used_at
       from spaces s
       left join space_api_tokens tokens
         on tokens.space_id = s.id and tokens.token_hash = $2 and tokens.revoked_at is null
       where s.space_id = $1 and s.status = 'active'`,
      [request.spaceId, tokenHash],
    );
    const [row] = result.rows;

    return row === undefined ? undefined : read.schema.parse(row);
  }

  #settleAuthorization<Row extends AuthorizationRow, Grant extends SpaceRequestGrant>(
    row: Row | undefined,
    grant: (space: Row) => Grant,
  ): SpaceRequestAuthorization<Grant> {
    if (row === undefined) return { outcome: "missing" };
    if (row.token_id === null) return { outcome: "unauthorized" };
    const granted = grant(row);
    this.#recordTokenUse(row.token_id, row.token_last_used_at);

    return { outcome: "authorized", ...granted };
  }

  /**
   * Usage metadata is advisory: it is written off the response path, and only
   * when the stored value is older than the one-minute resolution, so a client
   * polling every few seconds does not write on every request. The guard is
   * repeated in the statement so concurrent requests write at most once.
   */
  #recordTokenUse(tokenId: number, lastUsedAt: Date | null): void {
    const now = this.#now();
    if (!apiTokenUseIsStale(lastUsedAt ?? undefined, now)) return;
    void this.#database()
      .query(
        `update space_api_tokens set last_used_at = $2
         where id = $1 and revoked_at is null and (last_used_at is null or last_used_at <= $3)`,
        [tokenId, now, new Date(now.getTime() - API_TOKEN_USE_RESOLUTION_MS)],
      )
      .catch(() => undefined);
  }

  async listSpaces(): Promise<readonly SpaceRecord[]> {
    const records = await loadSpaceRecords(this.#database());

    return records.map((record) => record.value);
  }

  /**
   * Outside a caller-owned transaction the snapshot is memoized by registry
   * generation. Every registry write bumps the generation in its own
   * transaction, so a matching generation proves the memo is exactly what a
   * fresh read would return, and a request costs one generation read
   * (ADR 0033). Requests that observed the same generation share one rebuild;
   * the rebuild reads after they observed it, so it is never older.
   */
  async loadEdgeSnapshot(): Promise<EdgeSpaceSnapshot> {
    const encryption = this.#capabilityKeyEncryption();
    if (this.#transactionClient !== undefined) {
      return this.#readEdgeSnapshot(this.#transactionClient, encryption);
    }
    const { generation } = await this.getGeneration();
    const memo = this.#edgeSnapshot;
    if (memo !== undefined && memo.generation === generation) return memo;
    const pending = this.#edgeSnapshotBuild;
    if (pending !== undefined && pending.generation === generation) return pending.snapshot;
    const build = { generation, snapshot: this.#readEdgeSnapshot(this.#pool, encryption) };
    this.#edgeSnapshotBuild = build;
    try {
      const snapshot = await build.snapshot;
      this.#edgeSnapshot = snapshot;

      return snapshot;
    } finally {
      if (this.#edgeSnapshotBuild === build) this.#edgeSnapshotBuild = undefined;
    }
  }

  async createSpace(
    policy: SpacePolicy,
    resolverCredentials: readonly ResolverCredentialInput[] = [],
  ): Promise<RegistryMutation<SpaceRecord>> {
    const parsed = parseSpacePolicy(policy);
    rejectRetiredResolvers(parsed);
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
        const plan = planResolverCredentials(parsed, resolverCredentials, new Set());
        await insertPolicyChildren(
          client,
          recordId,
          parsed,
          this.#sealSupplied(parsed.id, plan.supplied, now),
        );
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
      const { resolverCredentials, resolvers, ...policyUpdate } = update;
      const policy = parseSpacePolicy({
        ...policyUpdate,
        id: stored.value.policy.id,
        routeClass: stored.value.policy.routeClass,
        resolvers: resolvers ?? stored.value.policy.resolvers,
      });
      return this.#writePolicy(
        client,
        recordId,
        stored.value,
        policy,
        resolverCredentials ?? [],
        now,
      );
    });
  }

  async editResolver(
    spaceId: string,
    change: ResolverChange,
  ): Promise<RegistryMutation<SpaceRecord>> {
    return this.#mutate(spaceId, async (client, recordId, now) => {
      const [stored] = await loadSpaceRecords(client, { spaceId });
      if (stored === undefined) throw new Error("the locked Space could not be loaded");
      const policy = parseSpacePolicy({
        ...stored.value.policy,
        resolvers: applyResolverChange(stored.value.policy, change),
      });
      return this.#writePolicy(
        client,
        recordId,
        stored.value,
        policy,
        change.credential === undefined ? [] : [change.credential],
        now,
      );
    });
  }

  /**
   * The one policy write: every child row is replaced, and each s3 resolver
   * keeps its sealed credential unless the caller supplied a new one. Kept
   * envelopes are copied as stored, never opened, so one unreadable secret
   * cannot block edits to the rest of the Space.
   */
  async #writePolicy(
    client: PoolClient,
    recordId: number,
    stored: SpaceRecord,
    policy: SpacePolicy,
    supplied: readonly ResolverCredentialInput[],
    now: Date,
  ): Promise<SpaceRecord> {
    rejectRetiredResolvers(policy);
    const existing = await client.query<ResolverCredentialRow>(
      `select ${RESOLVER_CREDENTIAL_COLUMNS} from space_resolvers
       where space_id = $1 and sealed_credential is not null`,
      [recordId],
    );
    const sealedById = new Map(existing.rows.map((row) => [row.resolver_id, sealedColumns(row)]));
    const plan = planResolverCredentials(policy, supplied, new Set(sealedById.keys()));
    const credentials = this.#sealSupplied(policy.id, plan.supplied, now);
    for (const resolverId of plan.kept) {
      const kept = sealedById.get(resolverId);
      if (kept !== undefined) credentials.set(resolverId, kept);
    }
    await client.query(
      `update spaces set qualities = $2, default_quality = $3, updated_at = $4 where id = $1`,
      [recordId, policy.qualities, policy.defaultQuality, now],
    );
    await client.query(`delete from space_source_origins where space_id = $1`, [recordId]);
    await client.query(`delete from space_resolvers where space_id = $1`, [recordId]);
    await insertPolicyChildren(client, recordId, policy, credentials);
    return { ...stored, policy, updatedAt: now };
  }

  /** Seals every supplied credential under its resolver scope; needs the registry encryption key. */
  #sealSupplied(
    spaceId: string,
    supplied: ReadonlyMap<string, ResolverCredentialInput>,
    now: Date,
  ): Map<string, SealedCredentialColumns> {
    const sealed = new Map<string, SealedCredentialColumns>();
    if (supplied.size === 0) return sealed;
    const encryption = this.#capabilityKeyEncryption();
    for (const [resolverId, input] of supplied) {
      const envelope = encryption.sealSecret(
        spaceId,
        credentialScope(resolverId, input.accessKeyId),
        Buffer.from(input.secretAccessKey, "utf8"),
      );
      sealed.set(resolverId, {
        accessKeyId: input.accessKeyId,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        updatedAt: now,
      });
    }
    return sealed;
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
    // The unique index on token_hash makes the equality filter authoritative:
    // at most one row can match, so a returned row is the verification.
    const result = await this.#database().query(
      `select tokens.id, tokens.last_used_at
       from space_api_tokens tokens
       join spaces on spaces.id = tokens.space_id
       where spaces.space_id = $1 and spaces.status = 'active'
         and tokens.token_hash = $2 and tokens.revoked_at is null`,
      [spaceId, apiTokenHash(token)],
    );
    const [row] = result.rows;
    if (row === undefined) return false;
    const match = tokenUseRowSchema.parse(row);
    this.#recordTokenUse(match.id, match.last_used_at);

    return true;
  }

  async listApiTokens(spaceId: string): Promise<readonly ApiTokenSummary[]> {
    const { tokens } = await this.#spaceChildren(spaceId, {
      column: `(select coalesce(json_agg(json_build_object('id', t.id, 'label', t.label,
          'display_prefix', t.display_prefix, 'created_at', t.created_at,
          'last_used_at', t.last_used_at, 'revoked_at', t.revoked_at) order by t.id), '[]')
        from space_api_tokens t where t.space_id = s.id) as tokens`,
      schema: apiTokensRowSchema,
    });

    return tokens.map(apiTokenSummary);
  }

  async revokeApiToken(
    spaceId: string,
    tokenId: number,
  ): Promise<RegistryMutation<ApiTokenSummary>> {
    return this.#mutate(
      spaceId,
      async (client, recordId, now) => {
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
      },
      { anyStatus: true },
    );
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

  async listResolverCredentials(spaceId: string): Promise<readonly ResolverCredentialSummary[]> {
    const { credentials } = await this.#spaceChildren(spaceId, {
      column: `(select coalesce(json_agg(json_build_object('resolver_id', c.resolver_id,
          'access_key_id', c.credential_access_key_id, 'updated_at', c.credential_updated_at)
          order by c.id), '[]')
        from space_resolvers c where c.space_id = s.id and c.sealed_credential is not null)
        as credentials`,
      schema: resolverCredentialsRowSchema,
    });

    return credentials.map((credential) => ({
      resolverId: credential.resolver_id,
      accessKeyId: credential.access_key_id,
      updatedAt: credential.updated_at,
    }));
  }

  async getResolverCredential(
    spaceId: string,
    resolverId: string,
  ): Promise<ResolverCredential | undefined> {
    const result = await this.#database().query(
      `select ${SEALED_RESOLVER_CREDENTIAL_JSON} as credential
       from space_resolvers c join spaces s on s.id = c.space_id
       where s.space_id = $1 and c.resolver_id = $2 and c.sealed_credential is not null`,
      [spaceId, resolverId],
    );
    const [row] = result.rows;
    if (row === undefined) return undefined;

    return this.#openResolverCredential(
      { spaceId, resolverId },
      credentialRowSchema.parse(row).credential,
    );
  }

  async listCapabilityKeys(spaceId: string): Promise<readonly CapabilityKeySummary[]> {
    const { keys } = await this.#spaceChildren(spaceId, {
      column: `(select coalesce(json_agg(json_build_object('id', k.id, 'key_id', k.key_id,
          'accepted_at', k.accepted_at, 'disabled_at', k.disabled_at) order by k.id), '[]')
        from space_capability_keys k where k.space_id = s.id) as keys`,
      schema: capabilityKeysRowSchema,
    });

    return keys.map(capabilityKeySummary);
  }

  /**
   * The row of a Space of any status with one aggregated child column, so an
   * admin listing proves the Space exists in the statement that lists it. Each
   * caller names its column and the schema that parses it.
   */
  async #spaceChildren<Row>(
    spaceId: string,
    read: { column: string; schema: z.ZodType<Row> },
  ): Promise<Row> {
    const result = await this.#database().query(
      `select ${read.column} from spaces s where s.space_id = $1`,
      [spaceId],
    );
    const [row] = result.rows;
    if (row === undefined) throw new SpaceRegistryError("not_found", "the Space does not exist");

    return read.schema.parse(row);
  }

  /** Opens one sealed resolver credential; throws when the envelope will not open. */
  #openResolverCredential(
    resolver: ResolverIdentity,
    sealed: SealedResolverCredential,
  ): ResolverCredential {
    const secret = this.#capabilityKeyEncryption().openSecret(
      resolver.spaceId,
      credentialScope(resolver.resolverId, sealed.access_key_id),
      { nonce: sealed.nonce, ciphertext: sealed.ciphertext },
    );

    return {
      accessKeyId: sealed.access_key_id,
      secretAccessKey: Buffer.from(secret).toString("utf8"),
    };
  }

  /**
   * A credential read beside its policy. An envelope that will not open, or a
   * registry without encryption, is reported as `unreadable`, so the
   * resolution that needs it fails as a separate credential read would have.
   */
  #readResolverCredential(
    resolver: ResolverIdentity,
    sealed: SealedResolverCredential | null,
  ): ResolverCredentialRead {
    if (sealed === null) return { outcome: "absent" };
    try {
      return { outcome: "opened", credential: this.#openResolverCredential(resolver, sealed) };
    } catch {
      return { outcome: "unreadable" };
    }
  }

  async disableCapabilityKey(
    spaceId: string,
    keyId: string,
  ): Promise<RegistryMutation<CapabilityKeySummary>> {
    return this.#mutate(
      spaceId,
      async (client, recordId, now) => {
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
      },
      { anyStatus: true },
    );
  }

  /**
   * Every Space-scoped mutation runs as: one transaction, a lock on the Space
   * row, one clock reading, the statements, then exactly one generation bump.
   * The helper owns that skeleton so a mutation cannot forget the bump and
   * leave the Edge snapshot stale. Credential kill switches pass
   * `anyStatus: true` so a compromised token or key on a decommissioned Space
   * can still be shut off.
   */
  async #mutate<T>(
    spaceId: string,
    work: (client: PoolClient, recordId: number, now: Date) => Promise<T>,
    options: { anyStatus?: boolean } = {},
  ): Promise<RegistryMutation<T>> {
    return this.#write(async (client) => {
      const recordId = await lockSpace(client, spaceId, {
        activeOnly: options.anyStatus !== true,
      });
      const now = this.#now();
      const value = await work(client, recordId, now);
      const generation = await bumpGeneration(client, now);
      return { generation, value };
    });
  }

  /**
   * Opens the accepted (not disabled) keys one per-Space read returned, with
   * `openSealedKeys` tolerance.
   */
  #openCapabilityKeys(
    publicSpaceId: string,
    sealed: readonly SealedCapabilityKeyRow[],
  ): Map<string, Uint8Array> {
    const opened = openSealedKeys(this.#capabilityKeyEncryption(), publicSpaceId, sealed);
    if (opened.undecryptable > 0) {
      this.#reportUndecryptableKeys("space_authorization", opened.undecryptable);
    }

    return opened.keys;
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

  /** Each read is one statement, so outside a caller-owned transaction it needs none. */
  #database(): RegistryDatabase {
    return this.#transactionClient ?? this.#pool;
  }

  /**
   * The whole snapshot in one statement: the generation and every active
   * Space with its policy and sealed keys, so generation, policies, and keys
   * come from one snapshot without an enclosing transaction.
   */
  async #readEdgeSnapshot(
    database: RegistryDatabase,
    encryption: CapabilityKeyEncryption,
  ): Promise<EdgeSpaceSnapshot> {
    const result = await database.query(
      `select m.generation, m.updated_at,
         (select coalesce(json_agg(${SPACE_POLICY_WITH_KEYS_JSON} order by s.id), '[]')
          from spaces s where s.status = 'active') as spaces
       from space_registry_metadata m where m.id = 1`,
    );
    const [row] = result.rows;
    if (row === undefined) throw new Error("Space Registry metadata is not initialized");
    const read = edgeSnapshotRowSchema.parse(row);
    const spaces: SpacePolicy[] = [];
    const capabilityKeys = new Map<string, Map<string, Uint8Array>>();
    let undecryptable = 0;
    for (const space of read.spaces) {
      const policy = spacePolicyFromRow(space);
      const opened = openSealedKeys(encryption, policy.id, space.capability_keys);
      spaces.push(policy);
      capabilityKeys.set(policy.id, opened.keys);
      undecryptable += opened.undecryptable;
    }
    if (undecryptable > 0) this.#reportUndecryptableKeys("edge_snapshot", undecryptable);

    return {
      schemaVersion: "v1",
      generation: read.generation,
      registryUpdatedAt: read.updated_at,
      spaces,
      capabilityKeys,
    };
  }
}
