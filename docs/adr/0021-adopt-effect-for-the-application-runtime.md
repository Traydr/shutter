# Adopt Effect for the application runtime

Effect v4 owns the application runtime in Shutter Control, both Executors, and
the protocol package. Control and the Executors use Effect HTTP and Node runtime
services, while Hono remains only as the Cloudflare Worker's HTTP shell.
`@effect/sql-pg` owns Control's Postgres access instead of the raw driver, and
`PgMigrator` owns schema migrations. The retry schedule deliberately remains
durable state in Postgres rather than moving to `Schedule`, because retries must
outlive any Control process. Schema-backed job parsers are exposed only through
`@shutter/protocol/jobs`, and the Worker cannot import that subpath, keeping
Schema out of its bundle. This revises the runtime and persistence stack
described in ADR-0017, whose workspace decision still stands.
