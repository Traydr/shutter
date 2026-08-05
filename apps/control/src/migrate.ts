import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import renditionJobs from "../migrations/0001_rendition_jobs.js";

const program = Effect.gen(function* () {
  yield* PgMigrator.run({
    loader: PgMigrator.fromRecord({ "0001_rendition_jobs": renditionJobs }),
  });
}).pipe(
  Effect.provide(
    Layer.unwrap(
      Config.schema(Schema.URLFromString, "DATABASE_URL").pipe(
        Effect.map((url) => PgClient.layer({ url: Redacted.make(url.href) })),
      ),
    ),
  ),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
);

NodeRuntime.runMain(program);
