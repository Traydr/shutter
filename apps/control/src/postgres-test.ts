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

export async function createPostgresTestLifecycle(): Promise<PostgresTestLifecycle> {
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
  const migrationsDirectory = new URL("../drizzle/", import.meta.url);
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_.+\.sql$/u.test(file))
    .sort();
  for (const file of migrationFiles) {
    const migration = await readFile(new URL(file, migrationsDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await pool.query(statement);
    }
  }

  return {
    lifecycle: new PostgresPreviewJobLifecycle(pool),
    pool,
    close: () => pool.end(),
  };
}
