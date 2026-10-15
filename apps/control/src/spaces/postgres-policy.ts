import { parseSpacePolicy, type SpacePolicy } from "@shutter/protocol";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { SpaceRecord } from "./registry.js";

/** A pool or a client inside a caller-owned transaction; every read here is one statement. */
export type RegistryDatabase = Pool | PoolClient;

/*
 * A policy spans three tables. Each read aggregates the child rows into JSON
 * beside the Space row, so the whole policy comes back from one statement,
 * which sees one snapshot without an enclosing transaction and costs one
 * round trip. The aggregates order by row ID, the order the rows were written
 * in. Every fragment below reads the Space through the alias `s`.
 */
const ORIGINS_JSON = `(select coalesce(json_agg(json_build_object(
      'origin', o.origin, 'path_prefix', o.path_prefix) order by o.id), '[]')
    from space_source_origins o where o.space_id = s.id)`;

const RESOLVERS_JSON = `(select coalesce(json_agg(json_build_object(
      'resolver_id', r.resolver_id, 'resolver_type', r.resolver_type, 'config', r.config)
      order by r.id), '[]')
    from space_resolvers r where r.space_id = s.id)`;

const SEALED_CAPABILITY_KEYS_JSON = `(select coalesce(json_agg(json_build_object(
      'key_id', k.key_id, 'sealed_nonce', k.sealed_nonce, 'sealed_key', k.sealed_key)
      order by k.id), '[]')
    from space_capability_keys k where k.space_id = s.id and k.disabled_at is null)`;

/** The columns of one stored Space record, children included. */
export const SPACE_RECORD_COLUMNS = `s.id, s.space_id, s.route_class, s.status, s.qualities,
  s.default_quality, s.created_at, s.updated_at, s.decommissioned_at,
  ${ORIGINS_JSON} as origins, ${RESOLVERS_JSON} as resolvers`;

/** The Space's accepted Capability Keys, still sealed, oldest first. */
export const SEALED_CAPABILITY_KEYS_COLUMN = `${SEALED_CAPABILITY_KEYS_JSON} as capability_keys`;

/**
 * One Space as a JSON object, for a read that returns every active Space in a
 * single row: its policy fields and its accepted, sealed Capability Keys.
 */
export const SPACE_POLICY_WITH_KEYS_JSON = `json_build_object('space_id', s.space_id,
  'route_class', s.route_class, 'qualities', s.qualities, 'default_quality', s.default_quality,
  'origins', ${ORIGINS_JSON}, 'resolvers', ${RESOLVERS_JSON},
  'capability_keys', ${SEALED_CAPABILITY_KEYS_JSON})`;

const originRowSchema = z.object({ origin: z.string(), path_prefix: z.string() });

const resolverRowSchema = z.object({
  resolver_id: z.string(),
  resolver_type: z.string(),
  /** The kind-specific public fields; `parseSpacePolicy` is the boundary that validates them. */
  config: z.record(z.string(), z.json()),
});

export const sealedCapabilityKeyRowSchema = z.object({
  key_id: z.string(),
  sealed_nonce: z.string(),
  sealed_key: z.string(),
});

export type SealedCapabilityKeyRow = z.infer<typeof sealedCapabilityKeyRowSchema>;

/** The columns a policy is built from, whether they arrive as row columns or inside JSON. */
export const spacePolicyRowSchema = z.object({
  space_id: z.string(),
  route_class: z.string(),
  qualities: z.array(z.int()),
  default_quality: z.int(),
  origins: z.array(originRowSchema),
  resolvers: z.array(resolverRowSchema),
});

type SpacePolicyRow = z.infer<typeof spacePolicyRowSchema>;

export const spaceRecordRowSchema = spacePolicyRowSchema.extend({
  id: z.int(),
  status: z.enum(["active", "decommissioned"]),
  created_at: z.date(),
  updated_at: z.date(),
  decommissioned_at: z.date().nullable(),
});

type SpaceRecordRow = z.infer<typeof spaceRecordRowSchema>;

export const sealedCapabilityKeysSchema = z.array(sealedCapabilityKeyRowSchema);

export interface StoredSpaceRecord {
  recordId: number;
  value: SpaceRecord;
}

export function spacePolicyFromRow(row: SpacePolicyRow): SpacePolicy {
  return parseSpacePolicy({
    id: row.space_id,
    routeClass: row.route_class,
    qualities: row.qualities,
    defaultQuality: row.default_quality,
    // parseSpacePolicy canonicalizes the root prefix "/" by omitting it.
    allowedSourceOrigins: row.origins.map((origin) => ({
      origin: origin.origin,
      pathPrefix: origin.path_prefix,
    })),
    resolvers: row.resolvers.map((resolver) => ({
      ...resolver.config,
      id: resolver.resolver_id,
      type: resolver.resolver_type,
    })),
  });
}

export function storedSpaceRecord(row: SpaceRecordRow): StoredSpaceRecord {
  const value: SpaceRecord = {
    policy: spacePolicyFromRow(row),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.decommissioned_at !== null) value.decommissionedAt = row.decommissioned_at;

  return { recordId: row.id, value };
}

export interface LoadSpaceRecordsOptions {
  activeOnly?: boolean;
  spaceId?: string;
}

export async function loadSpaceRecords(
  database: RegistryDatabase,
  options: LoadSpaceRecordsOptions = {},
): Promise<readonly StoredSpaceRecord[]> {
  const conditions: string[] = [];
  const parameters: string[] = [];
  if (options.activeOnly) conditions.push("s.status = 'active'");
  if (options.spaceId !== undefined) {
    parameters.push(options.spaceId);
    conditions.push(`s.space_id = $${parameters.length}`);
  }
  const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
  const result = await database.query(
    `select ${SPACE_RECORD_COLUMNS} from spaces s ${where} order by s.id`,
    parameters,
  );

  return result.rows.map((row) => storedSpaceRecord(spaceRecordRowSchema.parse(row)));
}
