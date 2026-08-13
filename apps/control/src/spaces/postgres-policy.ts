import { parseSpacePolicy } from "@shutter/protocol";
import type { Pool, PoolClient } from "pg";
import { transaction } from "../db/transaction.js";
import type { SpaceRecord } from "./registry.js";

interface SpaceRow {
  id: number;
  space_id: string;
  route_class: string;
  status: "active" | "decommissioned";
  qualities: number[];
  default_quality: number;
  created_at: Date;
  updated_at: Date;
  decommissioned_at: Date | null;
}

interface OriginRow {
  space_id: number;
  origin: string;
  path_prefix: string;
}

interface ResolverRow {
  space_id: number;
  resolver_id: string;
  resolver_type: string;
  allowed_project_ids: string[];
}

export interface StoredSpaceRecord {
  recordId: number;
  value: SpaceRecord;
}

export interface LoadSpaceRecordsOptions {
  activeOnly?: boolean;
  spaceId?: string;
}

/**
 * A policy spans three tables, so reading it from a pool without an enclosing
 * transaction could observe different snapshots per statement. Pool reads go
 * through one repeatable-read transaction instead.
 */
export async function loadSpaceRecordsFromPool(
  pool: Pool,
  options: LoadSpaceRecordsOptions = {},
): Promise<readonly StoredSpaceRecord[]> {
  return transaction(pool, (client) => loadSpaceRecords(client, options), {
    mode: "repeatable read read only",
  });
}

export async function loadSpaceRecords(
  database: PoolClient,
  options: LoadSpaceRecordsOptions = {},
): Promise<readonly StoredSpaceRecord[]> {
  const conditions: string[] = [];
  const parameters: string[] = [];
  if (options.activeOnly) conditions.push("status = 'active'");
  if (options.spaceId !== undefined) {
    parameters.push(options.spaceId);
    conditions.push(`space_id = $${parameters.length}`);
  }
  const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
  const spaces = await database.query<SpaceRow>(
    `select id, space_id, route_class, status, qualities, default_quality,
      created_at, updated_at, decommissioned_at
     from spaces ${where} order by id`,
    parameters,
  );
  if (spaces.rows.length === 0) return [];
  const recordIds = spaces.rows.map((row) => row.id);
  const [origins, resolvers] = await Promise.all([
    database.query<OriginRow>(
      `select space_id, origin, path_prefix from space_source_origins
       where space_id = any($1::integer[]) order by id`,
      [recordIds],
    ),
    database.query<ResolverRow>(
      `select space_id, resolver_id, resolver_type, allowed_project_ids from space_resolvers
       where space_id = any($1::integer[]) order by id`,
      [recordIds],
    ),
  ]);
  return spaces.rows.map((row) => {
    const policy = parseSpacePolicy({
      id: row.space_id,
      routeClass: row.route_class,
      qualities: row.qualities,
      defaultQuality: row.default_quality,
      allowedSourceOrigins: origins.rows
        .filter((origin) => origin.space_id === row.id)
        .map((origin) => ({
          origin: origin.origin,
          ...(origin.path_prefix === "/" ? {} : { pathPrefix: origin.path_prefix }),
        })),
      resolvers: resolvers.rows
        .filter((resolver) => resolver.space_id === row.id)
        .map((resolver) => ({
          id: resolver.resolver_id,
          type: resolver.resolver_type,
          allowedProjectIds: resolver.allowed_project_ids,
        })),
    });
    return {
      recordId: row.id,
      value: {
        policy,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.decommissioned_at === null ? {} : { decommissionedAt: row.decommissioned_at }),
      },
    };
  });
}
