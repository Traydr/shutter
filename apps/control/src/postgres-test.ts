import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import renditionJobsMigration from "../migrations/0001_rendition_jobs.js";
import {
  RenditionJobLifecycle,
  type RenditionJobLifecycleShape,
} from "./rendition-job-lifecycle.js";

interface RawQueryResult<A> {
  readonly rows: ReadonlyArray<A>;
  readonly rowCount: number | null;
}

export interface PostgresTestPool {
  query<A extends object = Record<string, unknown>>(
    statement: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<RawQueryResult<A>>;
}

export interface PostgresTestLifecycle {
  lifecycle: RenditionJobLifecycleShape;
  pool: PostgresTestPool;
  close(): Promise<void>;
}

function pgLayer(url: string, maxConnections: number) {
  return PgClient.layer({ url: Redacted.make(url), maxConnections });
}

export async function createPostgresTestLifecycle(): Promise<PostgresTestLifecycle> {
  const adminUrl = process.env.TEST_POSTGRES_URL;
  if (adminUrl === undefined) throw new Error("TEST_POSTGRES_URL is not configured");

  const database = `shutter_test_${randomUUID().replaceAll("-", "")}`;
  const admin = ManagedRuntime.make(pgLayer(adminUrl, 1));
  try {
    await admin.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${database}`);
      }),
    );
  } finally {
    await admin.dispose();
  }

  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${database}`;
  const runtime = ManagedRuntime.make(
    RenditionJobLifecycle.layer.pipe(Layer.provideMerge(pgLayer(databaseUrl.toString(), 8))),
  );
  await runtime.runPromise(renditionJobsMigration);
  const lifecycle = await runtime.runPromise(RenditionJobLifecycle);

  return {
    lifecycle,
    pool: {
      query: (statement, params) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql.unsafe(statement, params).raw) as RawQueryResult<never>;
          }),
        ),
    },
    close: () => runtime.dispose(),
  };
}
