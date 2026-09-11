import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigration,
  createPostgresTestLifecycle,
  type PostgresTestLifecycle,
} from "./postgres-test.js";
import { loadSpaceRecordsFromPool } from "./spaces/postgres-policy.js";

/**
 * Migration 0003 rewrites every retired UploadThing row into a template and
 * adds the origins that template needs, so a Space that parsed before the
 * migration still parses after it (ADR 0025).
 */
describe("migration 0003", () => {
  let test: PostgresTestLifecycle;

  beforeAll(async () => {
    test = await createPostgresTestLifecycle({ throughMigration: "0002" });
    await test.pool.query(`update space_registry_metadata set generation = 4 where id = 1`);
    const inserted = await test.pool.query<{ id: number }>(
      `insert into spaces (space_id, route_class, status, qualities, default_quality)
       values ('legacy', 'public', 'active', array[75], 75) returning id`,
    );
    const recordId = inserted.rows[0]?.id;
    await test.pool.query(
      `insert into space_source_origins (space_id, origin, path_prefix)
       values ($1, 'https://sources.example.com', '/media'), ($1, 'https://already.ufs.sh', '/')`,
      [recordId],
    );
    await test.pool.query(
      `insert into space_resolvers (space_id, resolver_id, resolver_type, allowed_project_ids)
       values ($1, 'uploadthing', 'uploadthing', array['project_one', 'Already', 'already'])`,
      [recordId],
    );
    await applyMigration(test.pool, "0003");
  });

  afterAll(async () => test.close());

  it("turns the uploadthing row into a template with the project allowlist", async () => {
    const [record] = await loadSpaceRecordsFromPool(test.pool, { spaceId: "legacy" });
    expect(record?.value.policy.resolvers).toEqual([
      {
        id: "uploadthing",
        type: "template",
        url: "https://{project}.ufs.sh/f/{file}",
        placeholders: { project: { allowed: ["project_one", "Already", "already"] }, file: {} },
      },
    ]);
  });

  it("refuses a project id that cannot become a hostname label", async () => {
    const other = await createPostgresTestLifecycle({ throughMigration: "0002" });
    try {
      const inserted = await other.pool.query<{ id: number }>(
        `insert into spaces (space_id, route_class, status, qualities, default_quality)
         values ('long', 'public', 'active', array[75], 75) returning id`,
      );
      await other.pool.query(
        `insert into space_source_origins (space_id, origin, path_prefix)
         values ($1, 'https://sources.example.com', '/')`,
        [inserted.rows[0]?.id],
      );
      await other.pool.query(
        `insert into space_resolvers (space_id, resolver_id, resolver_type, allowed_project_ids)
         values ($1, 'ut', 'uploadthing', array[$2])`,
        [inserted.rows[0]?.id, "p".repeat(64)],
      );
      await expect(applyMigration(other.pool, "0003")).rejects.toThrow("longer than 63 characters");
    } finally {
      await other.close();
    }
  });

  it("refuses to widen a narrower origin rule for a project host", async () => {
    const other = await createPostgresTestLifecycle({ throughMigration: "0002" });
    try {
      const inserted = await other.pool.query<{ id: number }>(
        `insert into spaces (space_id, route_class, status, qualities, default_quality)
         values ('narrow', 'public', 'active', array[75], 75) returning id`,
      );
      await other.pool.query(
        `insert into space_source_origins (space_id, origin, path_prefix)
         values ($1, 'https://narrow.ufs.sh', '/f/approved')`,
        [inserted.rows[0]?.id],
      );
      await other.pool.query(
        `insert into space_resolvers (space_id, resolver_id, resolver_type, allowed_project_ids)
         values ($1, 'ut', 'uploadthing', array['narrow'])`,
        [inserted.rows[0]?.id],
      );
      await expect(applyMigration(other.pool, "0003")).rejects.toThrow("narrower than /f");
    } finally {
      await other.close();
    }
  });

  it("adds the ufs.sh origin for each project the allowlist did not already cover", async () => {
    const [record] = await loadSpaceRecordsFromPool(test.pool, { spaceId: "legacy" });
    expect(record?.value.policy.allowedSourceOrigins).toEqual([
      { origin: "https://sources.example.com", pathPrefix: "/media" },
      { origin: "https://already.ufs.sh" },
      { origin: "https://project_one.ufs.sh", pathPrefix: "/f" },
    ]);
  });

  it("bumps the registry generation so the change reaches the Edge", async () => {
    const generation = await test.pool.query<{ generation: number }>(
      `select generation from space_registry_metadata where id = 1`,
    );
    expect(generation.rows[0]?.generation).toBe(5);
  });

  it("drops the retired column and constrains the new ones", async () => {
    const columns = await test.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'space_resolvers'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain("allowed_project_ids");
    expect(names).toEqual(
      expect.arrayContaining(["config", "credential_access_key_id", "sealed_credential"]),
    );
    const recordId = (
      await test.pool.query<{ id: number }>(`select id from spaces where space_id = 'legacy'`)
    ).rows[0]?.id;
    await expect(
      test.pool.query(
        `insert into space_resolvers (space_id, resolver_id, resolver_type, config)
         values ($1, 'bucket', 's3', '{}'::jsonb)`,
        [recordId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
