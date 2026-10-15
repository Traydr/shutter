import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { env } from "../env/server.js";
import type { ControlLogger } from "../logging.js";
import { createDatabasePool } from "./pool.js";

function testDatabaseUrl(): string {
  const url = env.TEST_POSTGRES_URL;
  if (url === undefined) throw new Error("TEST_POSTGRES_URL is not configured");

  return url;
}

describe("Control's database pool", () => {
  it("opens sessions with the server-side timeouts", async () => {
    const pool = createDatabasePool(testDatabaseUrl(), { emit() {}, async shutdown() {} });
    try {
      const settings = await pool.query<{ statement: string; idle: string }>(
        `select current_setting('statement_timeout') as statement,
          current_setting('idle_in_transaction_session_timeout') as idle`,
      );
      expect(settings.rows).toEqual([{ statement: "10s", idle: "30s" }]);
    } finally {
      await pool.end();
    }
  });

  it("reports a dropped idle connection instead of crashing, and reconnects", async () => {
    const emit = vi.fn<ControlLogger["emit"]>();
    const pool = createDatabasePool(testDatabaseUrl(), { emit, async shutdown() {} });
    const admin = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      const backend = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
      const pid = backend.rows[0]?.pid;
      // The client is idle in the pool now; the database ends its session.
      await admin.query("select pg_terminate_backend($1)", [pid]);

      await vi.waitFor(() =>
        expect(emit).toHaveBeenCalledWith("error", {
          event: "control.service.failed",
          outcome: "failed",
          failureCode: "service_unavailable",
          errorType: expect.any(String),
        }),
      );
      const after = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
      expect(after.rows[0]?.pid).not.toBe(pid);
    } finally {
      await admin.end();
      await pool.end();
    }
  });
});
