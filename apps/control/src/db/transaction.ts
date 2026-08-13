import type { Pool, PoolClient } from "pg";

export type TransactionMode = "read write" | "repeatable read read only";

/**
 * One transaction per call. The rollback is guarded so a failed rollback (for
 * example on a broken connection) never replaces the error that caused it.
 */
export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  options: { mode?: TransactionMode } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(
      options.mode === "repeatable read read only"
        ? "begin isolation level repeatable read read only"
        : "begin",
    );
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Keep the original error; the connection is released either way.
    }
    throw error;
  } finally {
    client.release();
  }
}
