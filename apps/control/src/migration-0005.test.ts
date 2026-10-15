import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigration,
  createPostgresTestLifecycle,
  type PostgresTestLifecycle,
} from "./postgres-test.js";

const NOW = "2026-10-15T12:00:00Z";

/** The job sweeps as `preview-job-lifecycle.ts` sends them, with the clock bound in. */
const SWEEPS = {
  expirePending: `update preview_jobs set status = 'failed', next_attempt_at = null, updated_at = $1
    where status = 'pending' and retry_deadline_at <= $1`,
  claimCandidate: `select space_id, source_id, kind from preview_jobs
    where kind = $2 and status = 'pending' and retry_deadline_at > $1
      and (next_attempt_at is null or next_attempt_at <= $1)
    order by created_at for update skip locked limit 1`,
  earliestRetry: `select min(next_attempt_at) from preview_jobs
    where kind = $2 and status = 'pending' and next_attempt_at > $1`,
  recoverLeases: `update preview_jobs set status = 'pending', processing_token = null, updated_at = $1
    where status = 'processing' and lease_expires_at <= $1`,
  runnable: `select kind from preview_jobs
    where status = 'pending' and retry_deadline_at > $1
      and (next_attempt_at is null or next_attempt_at <= $1)
    order by retry_deadline_at, created_at limit 100`,
} as const;

/**
 * Migration 0005 replaces the full `(kind, status, next_attempt_at)` index
 * with partial indexes over the rows still in flight, so the sweeps stop
 * scanning a ledger that keeps every ready and failed job.
 */
describe("migration 0005", () => {
  let test: PostgresTestLifecycle;

  beforeAll(async () => {
    test = await createPostgresTestLifecycle({ throughMigration: "0004" });
    // A grown ledger: almost every row settled, a small backlog in flight.
    await test.pool.query(
      `insert into preview_jobs
        (space_id, source_id, kind, status, retry_deadline_at, next_attempt_at,
         lease_expires_at, master_width, master_height, master_format, created_at)
       select 'space', 'source-' || n, case when n % 2 = 0 then 'video' else 'pdf' end,
         case when n <= 60 then 'pending' when n <= 80 then 'processing'
              when n % 10 = 0 then 'failed' else 'ready' end,
         $1::timestamptz + interval '1 hour',
         case when n <= 60 then $1::timestamptz - (n || ' seconds')::interval end,
         case when n > 60 and n <= 80 then $1::timestamptz + interval '10 minutes' end,
         640, 480, 'webp', $1::timestamptz - (n || ' seconds')::interval
       from generate_series(1, 40000) n`,
      [NOW],
    );
    await applyMigration(test.pool, "0005");
    await test.pool.query("analyze preview_jobs");
  });

  afterAll(async () => test.close());

  it("keeps only the partial indexes beside the primary key", async () => {
    const indexes = await test.pool.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = 'preview_jobs' order by indexname`,
    );

    expect(indexes.rows).toEqual([
      {
        indexname: "preview_jobs_pending_idx",
        indexdef:
          "CREATE INDEX preview_jobs_pending_idx ON public.preview_jobs USING btree (kind, next_attempt_at) WHERE (status = 'pending'::text)",
      },
      {
        indexname: "preview_jobs_processing_idx",
        indexdef:
          "CREATE INDEX preview_jobs_processing_idx ON public.preview_jobs USING btree (kind) WHERE (status = 'processing'::text)",
      },
      {
        indexname: "preview_jobs_space_id_source_id_kind_pk",
        indexdef:
          "CREATE UNIQUE INDEX preview_jobs_space_id_source_id_kind_pk ON public.preview_jobs USING btree (space_id, source_id, kind)",
      },
    ]);
  });

  it("serves every job sweep from a partial index rather than a table scan", async () => {
    const plans: Record<string, string> = {};
    for (const [name, sql] of Object.entries(SWEEPS)) {
      const parameters = sql.includes("$2") ? [NOW, "video"] : [NOW];
      const plan = await test.pool.query<{ "QUERY PLAN": string }>(`explain ${sql}`, parameters);
      plans[name] = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    }

    expect(plans.expirePending).toContain("preview_jobs_pending_idx");
    expect(plans.claimCandidate).toContain("preview_jobs_pending_idx");
    expect(plans.earliestRetry).toContain("preview_jobs_pending_idx");
    expect(plans.recoverLeases).toContain("preview_jobs_processing_idx");
    expect(plans.runnable).toContain("preview_jobs_pending_idx");
    for (const plan of Object.values(plans)) expect(plan).not.toContain("Seq Scan");
  });
});
