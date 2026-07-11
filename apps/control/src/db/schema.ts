import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const renditionJobs = pgTable(
  "rendition_jobs",
  {
    spaceId: text("space_id").notNull(),
    sourceId: text("source_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    sourceCapability: text("source_capability"),
    executionCycle: integer("execution_cycle").notNull().default(0),
    attemptNumber: integer("attempt_number").notNull().default(0),
    retryDeadlineAt: timestamp("retry_deadline_at", { withTimezone: true }).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    processingToken: text("processing_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    masterKey: text("master_key"),
    masterWidth: integer("master_width"),
    masterHeight: integer("master_height"),
    masterFormat: text("master_format"),
    objectEtag: text("object_etag"),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.sourceId, table.kind] }),
    index("rendition_jobs_claim_idx").on(table.kind, table.status, table.nextAttemptAt),
    check("rendition_jobs_kind_check", sql`${table.kind} in ('video', 'pdf')`),
    check(
      "rendition_jobs_status_check",
      sql`${table.status} in ('pending', 'processing', 'ready', 'failed')`,
    ),
    check(
      "rendition_jobs_counter_check",
      sql`${table.executionCycle} >= 0 and ${table.attemptNumber} >= 0`,
    ),
  ],
);
