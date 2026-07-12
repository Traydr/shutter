import { randomUUID } from "node:crypto";
import type {
  JobFailureCode,
  JobStatus,
  RenditionJobRepresentation,
  RenditionKind,
} from "@shutter/protocol";
import { createFailedJobRepresentation } from "@shutter/protocol";
import type { Pool, PoolClient, QueryResultRow } from "pg";

export const MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_SECONDS = [60, 300, 1_800, 7_200] as const;
export const PROCESSING_LEASE_SECONDS = 15 * 60;
export const JOB_RETRY_WINDOW_SECONDS = 23 * 60 * 60;

export interface JobIdentity {
  spaceId: string;
  sourceId: string;
  kind: RenditionKind;
}

export interface SubmitJobInput extends JobIdentity {
  sourceCapability: string;
  capabilityExpiresAt: Date;
}

export interface ClaimedJob extends JobIdentity {
  sourceCapability: string;
  processingToken: string;
  executionCycle: number;
  attemptNumber: number;
}

export interface MasterCompletion {
  masterKey: string;
  width: number;
  height: number;
  format: "webp";
  objectEtag: string;
}

export interface JobRecord extends JobIdentity {
  status: JobStatus;
  sourceCapability?: string | undefined;
  executionCycle: number;
  attemptNumber: number;
  retryDeadlineAt: Date;
  nextAttemptAt?: Date | undefined;
  processingToken?: string | undefined;
  leaseExpiresAt?: Date | undefined;
  heartbeatAt?: Date | undefined;
  masterKey?: string | undefined;
  masterWidth?: number | undefined;
  masterHeight?: number | undefined;
  masterFormat?: "webp" | undefined;
  objectEtag?: string | undefined;
  failureCode?: JobFailureCode | undefined;
}

export interface JobStore {
  submit(input: SubmitJobInput, now: Date): Promise<JobRecord>;
  get(identity: JobIdentity): Promise<JobRecord | undefined>;
  claim(kind: RenditionKind, now: Date): Promise<ClaimedJob | undefined>;
  heartbeat(identity: JobIdentity, processingToken: string, now: Date): Promise<boolean>;
  complete(
    identity: JobIdentity,
    processingToken: string,
    completion: MasterCompletion,
    now: Date,
  ): Promise<boolean>;
  fail(
    identity: JobIdentity,
    processingToken: string,
    failure: { retryable: boolean; code?: JobFailureCode },
    now: Date,
  ): Promise<boolean>;
  expirePendingJobs(now: Date): Promise<number>;
  recoverExpiredLeases(now: Date): Promise<number>;
  runnableJobKinds(now: Date, limit: number): Promise<readonly RenditionKind[]>;
  purgeSource(spaceId: string, sourceId: string, cleanup: () => Promise<void>): Promise<void>;
}

export function jobRepresentation(record: JobRecord): RenditionJobRepresentation {
  if (record.status === "pending" || record.status === "processing") {
    return { status: record.status };
  }
  if (record.status === "failed") {
    return createFailedJobRepresentation(record.failureCode ?? "internal_invariant");
  }
  if (
    record.masterWidth === undefined ||
    record.masterHeight === undefined ||
    record.masterFormat !== "webp"
  ) {
    return createFailedJobRepresentation("internal_invariant");
  }
  return {
    status: "ready",
    master: {
      sourceId: record.sourceId,
      kind: record.kind,
      width: record.masterWidth,
      height: record.masterHeight,
      format: record.masterFormat,
    },
  };
}

interface JobRow extends QueryResultRow {
  space_id: string;
  source_id: string;
  kind: RenditionKind;
  status: JobStatus;
  source_capability: string | null;
  execution_cycle: number;
  attempt_number: number;
  retry_deadline_at: Date;
  next_attempt_at: Date | null;
  processing_token: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  master_key: string | null;
  master_width: number | null;
  master_height: number | null;
  master_format: "webp" | null;
  object_etag: string | null;
  failure_code: JobFailureCode | null;
}

function fromRow(row: JobRow): JobRecord {
  return {
    spaceId: row.space_id,
    sourceId: row.source_id,
    kind: row.kind,
    status: row.status,
    executionCycle: row.execution_cycle,
    attemptNumber: row.attempt_number,
    retryDeadlineAt: row.retry_deadline_at,
    ...(row.source_capability === null ? {} : { sourceCapability: row.source_capability }),
    ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
    ...(row.processing_token === null ? {} : { processingToken: row.processing_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.heartbeat_at === null ? {} : { heartbeatAt: row.heartbeat_at }),
    ...(row.master_key === null ? {} : { masterKey: row.master_key }),
    ...(row.master_width === null ? {} : { masterWidth: row.master_width }),
    ...(row.master_height === null ? {} : { masterHeight: row.master_height }),
    ...(row.master_format === null ? {} : { masterFormat: row.master_format }),
    ...(row.object_etag === null ? {} : { objectEtag: row.object_etag }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
  };
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function retryDeadline(input: SubmitJobInput, now: Date): Date {
  return new Date(
    Math.min(input.capabilityExpiresAt.getTime(), now.getTime() + JOB_RETRY_WINDOW_SECONDS * 1_000),
  );
}

function identityKey(identity: JobIdentity): string {
  return `${identity.spaceId}\u0000${identity.sourceId}\u0000${identity.kind}`;
}

export class InMemoryJobStore implements JobStore {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #sourceLocks = new Map<string, Promise<void>>();

  async #withSourceLock<T>(spaceId: string, sourceId: string, work: () => Promise<T>): Promise<T> {
    const key = `${spaceId}\u0000${sourceId}`;
    const previous = this.#sourceLocks.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#sourceLocks.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#sourceLocks.get(key) === queued) this.#sourceLocks.delete(key);
    }
  }

  async submit(input: SubmitJobInput, now: Date): Promise<JobRecord> {
    return this.#withSourceLock(input.spaceId, input.sourceId, async () => {
      const key = identityKey(input);
      const existing = this.#jobs.get(key);
      if (existing !== undefined) {
        if (
          existing.status === "failed" &&
          (existing.failureCode === "source_expired" ||
            existing.failureCode === "attempts_exhausted")
        ) {
          const reactivated: JobRecord = {
            ...input,
            status: "pending",
            executionCycle: existing.executionCycle + 1,
            attemptNumber: 0,
            retryDeadlineAt: retryDeadline(input, now),
            nextAttemptAt: now,
          };
          this.#jobs.set(key, reactivated);
          return { ...reactivated };
        }
        return { ...existing };
      }
      const created: JobRecord = {
        ...input,
        status: "pending",
        executionCycle: 0,
        attemptNumber: 0,
        retryDeadlineAt: retryDeadline(input, now),
        nextAttemptAt: now,
      };
      this.#jobs.set(key, created);
      return { ...created };
    });
  }

  async get(identity: JobIdentity): Promise<JobRecord | undefined> {
    const record = this.#jobs.get(identityKey(identity));
    return record === undefined ? undefined : { ...record };
  }

  async claim(kind: RenditionKind, now: Date): Promise<ClaimedJob | undefined> {
    for (const [key, record] of this.#jobs) {
      if (record.status === "pending" && record.retryDeadlineAt <= now) {
        this.#jobs.set(key, {
          ...record,
          status: "failed",
          sourceCapability: undefined,
          nextAttemptAt: undefined,
          failureCode: "source_expired",
        });
      }
    }
    const record = [...this.#jobs.values()]
      .filter(
        (candidate) =>
          candidate.kind === kind &&
          candidate.status === "pending" &&
          candidate.retryDeadlineAt > now &&
          (candidate.nextAttemptAt === undefined || candidate.nextAttemptAt <= now),
      )
      .sort((left, right) => left.retryDeadlineAt.getTime() - right.retryDeadlineAt.getTime())[0];
    if (record?.sourceCapability === undefined) return undefined;
    const processingToken = randomUUID();
    const processing: JobRecord = {
      ...record,
      status: "processing",
      attemptNumber: record.attemptNumber + 1,
      processingToken,
      leaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_SECONDS * 1_000),
      heartbeatAt: now,
      nextAttemptAt: undefined,
    };
    this.#jobs.set(identityKey(processing), processing);
    return {
      spaceId: processing.spaceId,
      sourceId: processing.sourceId,
      kind: processing.kind,
      sourceCapability: processing.sourceCapability as string,
      processingToken,
      executionCycle: processing.executionCycle,
      attemptNumber: processing.attemptNumber,
    };
  }

  async heartbeat(identity: JobIdentity, processingToken: string, now: Date): Promise<boolean> {
    const record = this.#jobs.get(identityKey(identity));
    if (record?.status !== "processing" || record.processingToken !== processingToken) return false;
    this.#jobs.set(identityKey(identity), {
      ...record,
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_SECONDS * 1_000),
    });
    return true;
  }

  async complete(
    identity: JobIdentity,
    processingToken: string,
    completion: MasterCompletion,
    _now: Date,
  ): Promise<boolean> {
    return this.#withSourceLock(identity.spaceId, identity.sourceId, async () => {
      const record = this.#jobs.get(identityKey(identity));
      if (record?.status !== "processing" || record.processingToken !== processingToken)
        return false;
      this.#jobs.set(identityKey(identity), {
        ...record,
        status: "ready",
        sourceCapability: undefined,
        processingToken: undefined,
        leaseExpiresAt: undefined,
        heartbeatAt: undefined,
        masterKey: completion.masterKey,
        masterWidth: completion.width,
        masterHeight: completion.height,
        masterFormat: completion.format,
        objectEtag: completion.objectEtag,
        failureCode: undefined,
      });
      return true;
    });
  }

  async fail(
    identity: JobIdentity,
    processingToken: string,
    failure: { retryable: boolean; code?: JobFailureCode },
    now: Date,
  ): Promise<boolean> {
    const record = this.#jobs.get(identityKey(identity));
    if (record?.status !== "processing" || record.processingToken !== processingToken) return false;
    const delay = RETRY_DELAYS_SECONDS[record.attemptNumber - 1];
    if (failure.retryable && delay !== undefined) {
      const nextAttemptAt = new Date(now.getTime() + delay * 1_000);
      if (nextAttemptAt < record.retryDeadlineAt) {
        this.#jobs.set(identityKey(identity), {
          ...record,
          status: "pending",
          processingToken: undefined,
          leaseExpiresAt: undefined,
          heartbeatAt: undefined,
          nextAttemptAt,
        });
        return true;
      }
    }
    this.#jobs.set(identityKey(identity), {
      ...record,
      status: "failed",
      sourceCapability: undefined,
      processingToken: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      nextAttemptAt: undefined,
      failureCode: failure.retryable
        ? "attempts_exhausted"
        : (failure.code ?? "internal_invariant"),
    });
    return true;
  }

  async recoverExpiredLeases(now: Date): Promise<number> {
    let recovered = 0;
    for (const [key, record] of this.#jobs) {
      if (
        record.status !== "processing" ||
        record.leaseExpiresAt === undefined ||
        record.leaseExpiresAt > now
      ) {
        continue;
      }
      recovered += 1;
      this.#jobs.set(key, {
        ...record,
        status: record.attemptNumber >= MAX_ATTEMPTS ? "failed" : "pending",
        sourceCapability:
          record.attemptNumber >= MAX_ATTEMPTS ? undefined : record.sourceCapability,
        processingToken: undefined,
        leaseExpiresAt: undefined,
        heartbeatAt: undefined,
        nextAttemptAt: record.attemptNumber >= MAX_ATTEMPTS ? undefined : now,
        failureCode: record.attemptNumber >= MAX_ATTEMPTS ? "attempts_exhausted" : undefined,
      });
    }
    return recovered;
  }

  async expirePendingJobs(now: Date): Promise<number> {
    let expired = 0;
    for (const [key, record] of this.#jobs) {
      if (record.status !== "pending" || record.retryDeadlineAt > now) continue;
      expired += 1;
      this.#jobs.set(key, {
        ...record,
        status: "failed",
        sourceCapability: undefined,
        nextAttemptAt: undefined,
        failureCode: "source_expired",
      });
    }
    return expired;
  }

  async runnableJobKinds(now: Date, limit: number): Promise<readonly RenditionKind[]> {
    return [...this.#jobs.values()]
      .filter(
        (record) =>
          record.status === "pending" &&
          record.retryDeadlineAt > now &&
          (record.nextAttemptAt === undefined || record.nextAttemptAt <= now),
      )
      .sort((left, right) => left.retryDeadlineAt.getTime() - right.retryDeadlineAt.getTime())
      .slice(0, limit)
      .map((record) => record.kind);
  }

  async purgeSource(
    spaceId: string,
    sourceId: string,
    cleanup: () => Promise<void>,
  ): Promise<void> {
    await this.#withSourceLock(spaceId, sourceId, async () => {
      for (const [key, record] of this.#jobs) {
        if (record.spaceId === spaceId && record.sourceId === sourceId) this.#jobs.delete(key);
      }
      await cleanup();
    });
  }
}

async function lockSource(client: PoolClient, spaceId: string, sourceId: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `${spaceId}\u0000${sourceId}`,
  ]);
}

export class PostgresJobStore implements JobStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async submit(input: SubmitJobInput, now: Date): Promise<JobRecord> {
    return transaction(this.#pool, async (client) => {
      await lockSource(client, input.spaceId, input.sourceId);
      const deadline = retryDeadline(input, now);
      const inserted = await client.query<JobRow>(
        `insert into rendition_jobs
          (space_id, source_id, kind, status, source_capability, retry_deadline_at, next_attempt_at, updated_at)
         values ($1, $2, $3, 'pending', $4, $5, $6, $6)
         on conflict do nothing returning *`,
        [input.spaceId, input.sourceId, input.kind, input.sourceCapability, deadline, now],
      );
      if (inserted.rows[0] !== undefined) return fromRow(inserted.rows[0]);

      const existing = await client.query<JobRow>(
        `select * from rendition_jobs where space_id = $1 and source_id = $2 and kind = $3 for update`,
        [input.spaceId, input.sourceId, input.kind],
      );
      const current = existing.rows[0];
      if (current === undefined) throw new Error("job disappeared during submission");
      if (
        current.status !== "failed" ||
        (current.failure_code !== "source_expired" && current.failure_code !== "attempts_exhausted")
      ) {
        return fromRow(current);
      }
      const reactivated = await client.query<JobRow>(
        `update rendition_jobs set
          status = 'pending', source_capability = $4, execution_cycle = execution_cycle + 1,
          attempt_number = 0, retry_deadline_at = $5, next_attempt_at = $6,
          processing_token = null, lease_expires_at = null, heartbeat_at = null,
          failure_code = null, updated_at = $6
         where space_id = $1 and source_id = $2 and kind = $3 returning *`,
        [input.spaceId, input.sourceId, input.kind, input.sourceCapability, deadline, now],
      );
      return fromRow(reactivated.rows[0] as JobRow);
    });
  }

  async get(identity: JobIdentity): Promise<JobRecord | undefined> {
    const result = await this.#pool.query<JobRow>(
      `select * from rendition_jobs where space_id = $1 and source_id = $2 and kind = $3`,
      [identity.spaceId, identity.sourceId, identity.kind],
    );
    return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
  }

  async claim(kind: RenditionKind, now: Date): Promise<ClaimedJob | undefined> {
    const token = randomUUID();
    const lease = new Date(now.getTime() + PROCESSING_LEASE_SECONDS * 1_000);
    return transaction(this.#pool, async (client) => {
      await client.query(
        `update rendition_jobs set status = 'failed', source_capability = null,
          failure_code = 'source_expired', next_attempt_at = null, updated_at = $1
         where status = 'pending' and retry_deadline_at <= $1`,
        [now],
      );
      const result = await client.query<JobRow>(
        `with candidate as (
          select space_id, source_id, kind from rendition_jobs
          where kind = $1 and status = 'pending' and retry_deadline_at > $2
            and (next_attempt_at is null or next_attempt_at <= $2)
          order by created_at for update skip locked limit 1
        )
        update rendition_jobs jobs set status = 'processing', attempt_number = attempt_number + 1,
          processing_token = $3, lease_expires_at = $4, heartbeat_at = $2,
          next_attempt_at = null, updated_at = $2
        from candidate
        where jobs.space_id = candidate.space_id and jobs.source_id = candidate.source_id
          and jobs.kind = candidate.kind
        returning jobs.*`,
        [kind, now, token, lease],
      );
      const row = result.rows[0];
      if (row === undefined || row.source_capability === null) return undefined;
      return {
        spaceId: row.space_id,
        sourceId: row.source_id,
        kind: row.kind,
        sourceCapability: row.source_capability,
        processingToken: token,
        executionCycle: row.execution_cycle,
        attemptNumber: row.attempt_number,
      };
    });
  }

  async heartbeat(identity: JobIdentity, processingToken: string, now: Date): Promise<boolean> {
    const lease = new Date(now.getTime() + PROCESSING_LEASE_SECONDS * 1_000);
    const result = await this.#pool.query(
      `update rendition_jobs set heartbeat_at = $5, lease_expires_at = $6, updated_at = $5
       where space_id = $1 and source_id = $2 and kind = $3
         and status = 'processing' and processing_token = $4`,
      [identity.spaceId, identity.sourceId, identity.kind, processingToken, now, lease],
    );
    return result.rowCount === 1;
  }

  async complete(
    identity: JobIdentity,
    processingToken: string,
    completion: MasterCompletion,
    now: Date,
  ): Promise<boolean> {
    return transaction(this.#pool, async (client) => {
      await lockSource(client, identity.spaceId, identity.sourceId);
      const result = await client.query(
        `update rendition_jobs set status = 'ready', source_capability = null,
        processing_token = null, lease_expires_at = null, heartbeat_at = null,
        master_key = $5, master_width = $6, master_height = $7, master_format = $8,
        object_etag = $9, failure_code = null, updated_at = $10
       where space_id = $1 and source_id = $2 and kind = $3
         and status = 'processing' and processing_token = $4`,
        [
          identity.spaceId,
          identity.sourceId,
          identity.kind,
          processingToken,
          completion.masterKey,
          completion.width,
          completion.height,
          completion.format,
          completion.objectEtag,
          now,
        ],
      );
      return result.rowCount === 1;
    });
  }

  async fail(
    identity: JobIdentity,
    processingToken: string,
    failure: { retryable: boolean; code?: JobFailureCode },
    now: Date,
  ): Promise<boolean> {
    return transaction(this.#pool, async (client) => {
      const selected = await client.query<JobRow>(
        `select * from rendition_jobs where space_id = $1 and source_id = $2 and kind = $3
          and status = 'processing' and processing_token = $4 for update`,
        [identity.spaceId, identity.sourceId, identity.kind, processingToken],
      );
      const row = selected.rows[0];
      if (row === undefined) return false;
      const delay = RETRY_DELAYS_SECONDS[row.attempt_number - 1];
      if (failure.retryable && delay !== undefined && row.retry_deadline_at > now) {
        const nextAttempt = new Date(now.getTime() + delay * 1_000);
        if (nextAttempt < row.retry_deadline_at) {
          await client.query(
            `update rendition_jobs set status = 'pending', processing_token = null,
              lease_expires_at = null, heartbeat_at = null, next_attempt_at = $5, updated_at = $6
             where space_id = $1 and source_id = $2 and kind = $3 and processing_token = $4`,
            [identity.spaceId, identity.sourceId, identity.kind, processingToken, nextAttempt, now],
          );
          return true;
        }
      }
      const code = failure.retryable
        ? "attempts_exhausted"
        : (failure.code ?? "internal_invariant");
      await client.query(
        `update rendition_jobs set status = 'failed', source_capability = null,
          processing_token = null, lease_expires_at = null, heartbeat_at = null,
          next_attempt_at = null, failure_code = $5, updated_at = $6
         where space_id = $1 and source_id = $2 and kind = $3 and processing_token = $4`,
        [identity.spaceId, identity.sourceId, identity.kind, processingToken, code, now],
      );
      return true;
    });
  }

  async recoverExpiredLeases(now: Date): Promise<number> {
    const result = await this.#pool.query(
      `update rendition_jobs set status = case when attempt_number >= $2 then 'failed' else 'pending' end,
        source_capability = case when attempt_number >= $2 then null else source_capability end,
        processing_token = null, lease_expires_at = null, heartbeat_at = null,
        next_attempt_at = case when attempt_number >= $2 then null else $1 end,
        failure_code = case when attempt_number >= $2 then 'attempts_exhausted' else null end,
        updated_at = $1
       where status = 'processing' and lease_expires_at <= $1`,
      [now, MAX_ATTEMPTS],
    );
    return result.rowCount ?? 0;
  }

  async expirePendingJobs(now: Date): Promise<number> {
    const result = await this.#pool.query(
      `update rendition_jobs set status = 'failed', source_capability = null,
        next_attempt_at = null, failure_code = 'source_expired', updated_at = $1
       where status = 'pending' and retry_deadline_at <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  async runnableJobKinds(now: Date, limit: number): Promise<readonly RenditionKind[]> {
    const result = await this.#pool.query<Pick<JobRow, "kind">>(
      `select kind from rendition_jobs
       where status = 'pending' and retry_deadline_at > $1
         and (next_attempt_at is null or next_attempt_at <= $1)
       order by retry_deadline_at, created_at
       limit $2`,
      [now, limit],
    );
    return result.rows.map((row) => row.kind);
  }

  async purgeSource(
    spaceId: string,
    sourceId: string,
    cleanup: () => Promise<void>,
  ): Promise<void> {
    await transaction(this.#pool, async (client) => {
      await lockSource(client, spaceId, sourceId);
      await client.query(`delete from rendition_jobs where space_id = $1 and source_id = $2`, [
        spaceId,
        sourceId,
      ]);
      await cleanup();
    });
  }
}
