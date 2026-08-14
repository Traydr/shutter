import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const identity = (name = "id") => integer(name).primaryKey().generatedAlwaysAsIdentity();

export const spaces = pgTable(
  "spaces",
  {
    id: identity(),
    spaceId: text("space_id").notNull(),
    routeClass: text("route_class").notNull(),
    status: text("status").notNull().default("active"),
    qualities: integer("qualities").array().notNull(),
    defaultQuality: integer("default_quality").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("spaces_space_id_unique").on(table.spaceId),
    check("spaces_route_class_check", sql`${table.routeClass} in ('public', 'private')`),
    check("spaces_status_check", sql`${table.status} in ('active', 'decommissioned')`),
    check(
      "spaces_decommissioned_at_check",
      sql`(${table.status} = 'active' and ${table.decommissionedAt} is null)
        or (${table.status} = 'decommissioned' and ${table.decommissionedAt} is not null)`,
    ),
    check(
      "spaces_quality_policy_check",
      sql`cardinality(${table.qualities}) > 0 and ${table.defaultQuality} = any(${table.qualities})`,
    ),
  ],
);

export const spaceSourceOrigins = pgTable(
  "space_source_origins",
  {
    id: identity(),
    spaceRecordId: integer("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "restrict" }),
    origin: text("origin").notNull(),
    pathPrefix: text("path_prefix").notNull(),
  },
  (table) => [
    uniqueIndex("space_source_origins_rule_unique").on(
      table.spaceRecordId,
      table.origin,
      table.pathPrefix,
    ),
  ],
);

export const spaceResolvers = pgTable(
  "space_resolvers",
  {
    id: identity(),
    spaceRecordId: integer("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "restrict" }),
    resolverId: text("resolver_id").notNull(),
    resolverType: text("resolver_type").notNull(),
    allowedProjectIds: text("allowed_project_ids").array().notNull(),
  },
  (table) => [
    uniqueIndex("space_resolvers_space_resolver_unique").on(table.spaceRecordId, table.resolverId),
    check("space_resolvers_type_check", sql`${table.resolverType} = 'uploadthing'`),
    check("space_resolvers_projects_check", sql`cardinality(${table.allowedProjectIds}) > 0`),
  ],
);

export const spaceApiTokens = pgTable(
  "space_api_tokens",
  {
    id: identity(),
    spaceRecordId: integer("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "restrict" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull(),
    displayPrefix: text("display_prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("space_api_tokens_hash_unique").on(table.tokenHash)],
);

export const spaceCapabilityKeys = pgTable(
  "space_capability_keys",
  {
    id: identity(),
    spaceRecordId: integer("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "restrict" }),
    keyId: text("key_id").notNull(),
    sealedNonce: text("sealed_nonce").notNull(),
    sealedKey: text("sealed_key").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("space_capability_keys_space_key_unique").on(table.spaceRecordId, table.keyId),
  ],
);

export const spaceRegistryMetadata = pgTable(
  "space_registry_metadata",
  {
    id: identity(),
    generation: integer("generation").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("space_registry_metadata_singleton_check", sql`${table.id} = 1`),
    check("space_registry_metadata_generation_check", sql`${table.generation} >= 0`),
  ],
);

export const previewJobs = pgTable(
  "preview_jobs",
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
    index("preview_jobs_claim_idx").on(table.kind, table.status, table.nextAttemptAt),
    check("preview_jobs_kind_check", sql`${table.kind} in ('video', 'pdf')`),
    check(
      "preview_jobs_status_check",
      sql`${table.status} in ('pending', 'processing', 'ready', 'failed')`,
    ),
    check(
      "preview_jobs_counter_check",
      sql`${table.executionCycle} >= 0 and ${table.attemptNumber} >= 0`,
    ),
  ],
);
