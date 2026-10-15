import { operationalErrorType } from "@shutter/protocol";
import { Pool, type PoolConfig } from "pg";
import type { ControlLogger } from "../logging.js";

/**
 * Control's Postgres pool. Two connections stay open so a quiet replica does
 * not pay a TCP, startup, and SCRAM handshake on its next request, and extra
 * ones live five minutes. A request waits at most three seconds for a
 * connection and then fails with a retryable 503 instead of hanging. The
 * server ends any statement after ten seconds (registry reads take
 * milliseconds; the longest legitimate wait is a submission queued behind a
 * Source Purge's advisory lock) and any session left idle inside a
 * transaction for thirty, so a stuck request cannot pin a connection.
 */
export const DATABASE_POOL_OPTIONS = {
  max: 10,
  min: 2,
  idleTimeoutMillis: 5 * 60 * 1_000,
  connectionTimeoutMillis: 3_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 30_000,
  statement_timeout: 10_000,
  idle_in_transaction_session_timeout: 30_000,
} as const satisfies PoolConfig;

/**
 * Opens no connection until the first query. An idle pooled client whose
 * connection drops (a database restart, say) is reported here; unhandled, the
 * pool's error event would end the process. The pool discards that client and
 * connects afresh on the next checkout.
 */
export function createDatabasePool(connectionString: string, logger: ControlLogger): Pool {
  const pool = new Pool({ connectionString, ...DATABASE_POOL_OPTIONS });
  pool.on("error", (error) => {
    logger.emit("error", {
      event: "control.service.failed",
      outcome: "failed",
      failureCode: "service_unavailable",
      errorType: operationalErrorType(error),
    });
  });

  return pool;
}
