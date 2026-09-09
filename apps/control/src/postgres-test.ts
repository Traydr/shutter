import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { env } from "./env/server.js";
import { PostgresPreviewJobLifecycle } from "./preview-job-lifecycle.js";

export interface PostgresTestLifecycle {
  lifecycle: PostgresPreviewJobLifecycle;
  pool: Pool;
  close(): Promise<void>;
}

export interface PostgresTestOptions {
  /** Apply migrations up to and including this prefix (e.g. "0002"); every migration by default. */
  throughMigration?: string;
}

/** Applies the SQL migrations whose numeric prefix is at most `through`, in order. */
export async function applyMigrations(pool: Pool, through?: string): Promise<void> {
  const migrationsDirectory = new URL("../drizzle/", import.meta.url);
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_.+\.sql$/u.test(file))
    .filter((file) => through === undefined || file.slice(0, through.length) <= through)
    .sort();
  for (const file of migrationFiles) {
    const migration = await readFile(new URL(file, migrationsDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await pool.query(statement);
    }
  }
}

/** Applies exactly one migration file by its numeric prefix. */
export async function applyMigration(pool: Pool, prefix: string): Promise<void> {
  const migrationsDirectory = new URL("../drizzle/", import.meta.url);
  const file = (await readdir(migrationsDirectory)).find((candidate) =>
    candidate.startsWith(`${prefix}_`),
  );
  if (file === undefined) throw new Error(`migration ${prefix} does not exist`);
  const migration = await readFile(new URL(file, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) await pool.query(statement);
  }
}

export async function createPostgresTestLifecycle(
  options: PostgresTestOptions = {},
): Promise<PostgresTestLifecycle> {
  const adminUrl = env.TEST_POSTGRES_URL;
  if (adminUrl === undefined) throw new Error("TEST_POSTGRES_URL is not configured");

  const database = `shutter_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database ${database}`);
  } finally {
    await admin.end();
  }

  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${database}`;
  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 8 });
  await applyMigrations(pool, options.throughMigration);

  return {
    lifecycle: new PostgresPreviewJobLifecycle(pool),
    pool,
    close: () => pool.end(),
  };
}
