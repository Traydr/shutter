import { randomUUID } from "node:crypto";
import type {
  DerivativeJobRepresentation,
  DerivativeKind,
  JobFailureCode,
  JobStatus,
} from "@shutter/protocol";
import { createFailedJobRepresentation } from "@shutter/protocol";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { transaction } from "./db/transaction.js";

export const MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_SECONDS = [60, 300, 1_800, 7_200] as const;
export const PROCESSING_LEASE_SECONDS = 15 * 60;
export const JOB_RETRY_WINDOW_SECONDS = 23 * 60 * 60;

export interface JobIdentity {
  spaceId: string;
  sourceId: string;
  kind: DerivativeKind;
}

export interface SourceIdentity {
  spaceId: string;
  sourceId: string;
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

interface JobRecord extends JobIdentity {
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

export interface DerivativeJobView extends JobIdentity {
  status: JobStatus;
  executionCycle: number;
  attemptNumber: number;
  representation: DerivativeJobRepresentation;
}

export interface SubmissionResult {
  disposition: "created" | "existing" | "reactivated";
  job: DerivativeJobView;
}

export type AttemptMutationResult = { outcome: "accepted" } | { outcome: "stale_attempt" };

export type FailureResult =
  | { outcome: "retry_scheduled" }
  | { outcome: "terminal" }
  | { outcome: "stale_attempt" };

export interface MaintenanceResult {
  expiredPendingJobs: number;
  recoveredLeases: number;
  runnableKinds: readonly DerivativeKind[];
}

export interface DerivativeJobLifecycle {
  submit(input: SubmitJobInput, now: Date): Promise<SubmissionResult>;
  read(identity: JobIdentity): Promise<DerivativeJobView | undefined>;
  claim(kind: DerivativeKind, now: Date): Promise<ClaimedJob | undefined>;
  heartbeat(
    identity: JobIdentity,
    processingToken: string,
    now: Date,
  ): Promise<AttemptMutationResult>;
  complete(
    identity: JobIdentity,
    processingToken: string,
    completion: MasterCompletion,
    now: Date,
  ): Promise<AttemptMutationResult>;
  fail(
    identity: JobIdentity,
    processingToken: string,
    failure: { retryable: boolean; code?: JobFailureCode },
    now: Date,
  ): Promise<FailureResult>;
  maintain(now: Date, limit: number): Promise<MaintenanceResult>;
  withInvalidatedSource<T>(
    source: SourceIdentity,
    whileExclusive: () => Promise<T>,
  ): Promise<{ invalidatedJobs: number; value: T }>;
}

function jobRepresentation(record: JobRecord): DerivativeJobRepresentation {
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

function jobView(record: JobRecord): DerivativeJobView {
  return {
    spaceId: record.spaceId,
    sourceId: record.sourceId,
    kind: record.kind,
    status: record.status,
    executionCycle: record.executionCycle,
    attemptNumber: record.attemptNumber,
    representation: jobRepresentation(record),
  };
}

interface JobRow extends QueryResultRow {
  space_id: string;
  source_id: string;
  kind: DerivativeKind;
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

function retryDeadline(input: SubmitJobInput, now: Date): Date {
  return new Date(
    Math.min(input.capabilityExpiresAt.getTime(), now.getTime() + JOB_RETRY_WINDOW_SECONDS * 1_000),
  );
}

async function lockSource(client: PoolClient, spaceId: string, sourceId: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    postgresSourceLockKey(spaceId, sourceId),
  ]);
}

export function postgresSourceLockKey(spaceId: string, sourceId: string): string {
  return JSON.stringify([spaceId, sourceId]);
}

export class PostgresDerivativeJobLifecycle implements DerivativeJobLifecycle {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async submit(input: SubmitJobInput, now: Date): Promise<SubmissionResult> {
    return transaction(this.#pool, async (client) => {
      await lockSource(client, input.spaceId, input.sourceId);
      const deadline = retryDeadline(input, now);
      const inserted = await client.query<JobRow>(
        `insert into derivative_jobs
          (space_id, source_id, kind, status, source_capability, retry_deadline_at, next_attempt_at, updated_at)
         values ($1, $2, $3, 'pending', $4, $5, $6, $6)
         on conflict do nothing returning *`,
        [input.spaceId, input.sourceId, input.kind, input.sourceCapability, deadline, now],
      );
      if (inserted.rows[0] !== undefined) {
        return { disposition: "created", job: jobView(fromRow(inserted.rows[0])) };
      }

      const existing = await client.query<JobRow>(
        `select * from derivative_jobs where space_id = $1 and source_id = $2 and kind = $3 for update`,
        [input.spaceId, input.sourceId, input.kind],
      );
      const current = existing.rows[0];
      if (current === undefined) throw new Error("job disappeared during submission");
      if (
        current.status !== "failed" ||
        (current.failure_code !== "source_expired" && current.failure_code !== "attempts_exhausted")
      ) {
        return { disposition: "existing", job: jobView(fromRow(current)) };
      }
      const reactivated = await client.query<JobRow>(
        `update derivative_jobs set
          status = 'pending', source_capability = $4, execution_cycle = execution_cycle + 1,
          attempt_number = 0, retry_deadline_at = $5, next_attempt_at = $6,
          processing_token = null, lease_expires_at = null, heartbeat_at = null,
          failure_code = null, updated_at = $6
         where space_id = $1 and source_id = $2 and kind = $3 returning *`,
        [input.spaceId, input.sourceId, input.kind, input.sourceCapability, deadline, now],
      );
      return {
        disposition: "reactivated",
        job: jobView(fromRow(reactivated.rows[0] as JobRow)),
      };
    });
  }

  async read(identity: JobIdentity): Promise<DerivativeJobView | undefined> {
    const result = await this.#pool.query<JobRow>(
      `select * from derivative_jobs where space_id = $1 and source_id = $2 and kind = $3`,
      [identity.spaceId, identity.sourceId, identity.kind],
    );
    return result.rows[0] === undefined ? undefined : jobView(fromRow(result.rows[0]));
  }

  async claim(kind: DerivativeKind, now: Date): Promise<ClaimedJob | undefined> {
    const token = randomUUID();
    const lease = new Date(now.getTime() + PROCESSING_LEASE_SECONDS * 1_000);
    return transaction(this.#pool, async (client) => {
      await client.query(
        `update derivative_jobs set status = 'failed', source_capability = null,
          failure_code = 'source_expired', next_attempt_at = null, updated_at = $1
         where status = 'pending' and retry_deadline_at <= $1`,
        [now],
      );
      const result = await client.query<JobRow>(
        `with candidate as (
          select space_id, source_id, kind from derivative_jobs
          where kind = $1 and status = 'pending' and retry_deadline_at > $2
            and (next_attempt_at is null or next_attempt_at <= $2)
          order by created_at for update skip locked limit 1
        )
        update derivative_jobs jobs set status = 'processing', attempt_number = attempt_number + 1,
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

  async heartbeat(
    identity: JobIdentity,
    processingToken: string,
    now: Date,
  ): Promise<AttemptMutationResult> {
    const lease = new Date(now.getTime() + PROCESSING_LEASE_SECONDS * 1_000);
    const result = await this.#pool.query(
      `update derivative_jobs set heartbeat_at = $5, lease_expires_at = $6, updated_at = $5
       where space_id = $1 and source_id = $2 and kind = $3
         and status = 'processing' and processing_token = $4`,
      [identity.spaceId, identity.sourceId, identity.kind, processingToken, now, lease],
    );
    return { outcome: result.rowCount === 1 ? "accepted" : "stale_attempt" };
  }

  async complete(
    identity: JobIdentity,
    processingToken: string,
    completion: MasterCompletion,
    now: Date,
  ): Promise<AttemptMutationResult> {
    return transaction(this.#pool, async (client) => {
      await lockSource(client, identity.spaceId, identity.sourceId);
      const result = await client.query(
        `update derivative_jobs set status = 'ready', source_capability = null,
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
      return { outcome: result.rowCount === 1 ? "accepted" : "stale_attempt" };
    });
  }

  async fail(
    identity: JobIdentity,
    processingToken: string,
    failure: { retryable: boolean; code?: JobFailureCode },
    now: Date,
  ): Promise<FailureResult> {
    return transaction(this.#pool, async (client) => {
      const selected = await client.query<JobRow>(
        `select * from derivative_jobs where space_id = $1 and source_id = $2 and kind = $3
          and status = 'processing' and processing_token = $4 for update`,
        [identity.spaceId, identity.sourceId, identity.kind, processingToken],
      );
      const row = selected.rows[0];
      if (row === undefined) return { outcome: "stale_attempt" };
      const delay = RETRY_DELAYS_SECONDS[row.attempt_number - 1];
      if (failure.retryable && delay !== undefined && row.retry_deadline_at > now) {
        const nextAttempt = new Date(now.getTime() + delay * 1_000);
        if (nextAttempt < row.retry_deadline_at) {
          await client.query(
            `update derivative_jobs set status = 'pending', processing_token = null,
              lease_expires_at = null, heartbeat_at = null, next_attempt_at = $5, updated_at = $6
             where space_id = $1 and source_id = $2 and kind = $3 and processing_token = $4`,
            [identity.spaceId, identity.sourceId, identity.kind, processingToken, nextAttempt, now],
          );
          return { outcome: "retry_scheduled" };
        }
      }
      const code = failure.retryable
        ? "attempts_exhausted"
        : (failure.code ?? "internal_invariant");
      await client.query(
        `update derivative_jobs set status = 'failed', source_capability = null,
          processing_token = null, lease_expires_at = null, heartbeat_at = null,
          next_attempt_at = null, failure_code = $5, updated_at = $6
         where space_id = $1 and source_id = $2 and kind = $3 and processing_token = $4`,
        [identity.spaceId, identity.sourceId, identity.kind, processingToken, code, now],
      );
      return { outcome: "terminal" };
    });
  }

  async maintain(now: Date, limit: number): Promise<MaintenanceResult> {
    return transaction(this.#pool, async (client) => {
      const expired = await client.query(
        `update derivative_jobs set status = 'failed', source_capability = null,
          next_attempt_at = null, failure_code = 'source_expired', updated_at = $1
         where status = 'pending' and retry_deadline_at <= $1`,
        [now],
      );
      const recovered = await client.query(
        `update derivative_jobs set status = case when attempt_number >= $2 then 'failed' else 'pending' end,
          source_capability = case when attempt_number >= $2 then null else source_capability end,
          processing_token = null, lease_expires_at = null, heartbeat_at = null,
          next_attempt_at = case when attempt_number >= $2 then null else $1 end,
          failure_code = case when attempt_number >= $2 then 'attempts_exhausted' else null end,
          updated_at = $1
         where status = 'processing' and lease_expires_at <= $1`,
        [now, MAX_ATTEMPTS],
      );
      const runnable = await client.query<Pick<JobRow, "kind">>(
        `select kind from derivative_jobs
         where status = 'pending' and retry_deadline_at > $1
           and (next_attempt_at is null or next_attempt_at <= $1)
         order by retry_deadline_at, created_at
         limit $2`,
        [now, limit],
      );
      return {
        expiredPendingJobs: expired.rowCount ?? 0,
        recoveredLeases: recovered.rowCount ?? 0,
        runnableKinds: runnable.rows.map((row) => row.kind),
      };
    });
  }

  async withInvalidatedSource<T>(
    source: SourceIdentity,
    whileExclusive: () => Promise<T>,
  ): Promise<{ invalidatedJobs: number; value: T }> {
    const client = await this.#pool.connect();
    const lockKey = postgresSourceLockKey(source.spaceId, source.sourceId);
    let locked = false;
    try {
      await client.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
      locked = true;
      await client.query("begin");
      let invalidatedJobs: number;
      try {
        const deleted = await client.query(
          `delete from derivative_jobs where space_id = $1 and source_id = $2`,
          [source.spaceId, source.sourceId],
        );
        invalidatedJobs = deleted.rowCount ?? 0;
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      const value = await whileExclusive();
      return { invalidatedJobs, value };
    } finally {
      try {
        if (locked) {
          await client.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]);
        }
      } finally {
        client.release();
      }
    }
  }
}
