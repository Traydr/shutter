import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { env } from "./env/server.js";
import { PostgresRenditionJobLifecycle } from "./rendition-job-lifecycle.js";

export interface PostgresTestLifecycle {
  lifecycle: PostgresRenditionJobLifecycle;
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
  const migration = await readFile(
    new URL("../drizzle/0000_wooden_nicolaos.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) await pool.query(statement);
  }

  return {
    lifecycle: new PostgresRenditionJobLifecycle(pool),
    pool,
    close: () => pool.end(),
  };
}
