# Development

## Requirements

- Node 22 (`>=22.13.0 <23`, pinned in `.node-version`)
- pnpm 11.1 (pinned via `packageManager`)
- A container runtime — Docker, OrbStack, or Podman — for the Control tests,
  which start a throwaway `postgres:17-alpine` through testcontainers
  (`apps/control/src/postgres-test-global.ts`)

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` is the full gate: `lint` + `typecheck` + `test` + `build`. Only
`pnpm test:node` needs a running container runtime; lint, typecheck, build, and
the worker tests do not.

Cloudflare Workers Builds sets `WORKERS_CI=1` and has no Docker support, so
`scripts/run-workspace-tests.mjs` skips `test:node` there and still runs the
worker tests plus the rest of the gate. GitHub Actions runs everything.

## Configuration

Copy `.env.example` to `.env` at the repository root and fill in what you need;
`apps/edge/.dev.vars.example` covers the Worker separately. The Node services
load the root `.env` automatically in dev, and Wrangler loads `.dev.vars`.

Services are **fail-closed**: a missing variable does not crash startup, but the
affected route returns 401 or 503 until it is configured. You can bring the
stack up one capability at a time.

Control modules depend on the `ControlConfig` service defined in
`apps/control/src/env/server.ts`; production modules do not read `process.env`
directly.

## Running the services

Each Node service runs an Effect HTTP server with a `/healthz` endpoint, and its
port comes from `PORT`.

```sh
pnpm --filter @shutter/control dev         # control plane + Rendition Job API
pnpm --filter @shutter/executor-video dev
pnpm --filter @shutter/executor-pdf dev
pnpm --filter @shutter/edge dev            # see the caveat below
```

To exercise the Rendition Job API end to end you need Postgres plus
`DATABASE_URL`, `SPACE_API_TOKENS`, and `CAPABILITY_KEYS`. Run migrations first:

```sh
DATABASE_URL=... pnpm --filter @shutter/control db:migrate
```

`db:migrate` runs the Effect SQL `PgMigrator`; there is no schema-generation
command.

Mint Source Capabilities for job submission with `issueSourceCapability` from
`@shutter/protocol`. A capability's `locator` origin must be allowlisted by the
target Space in `packages/space-config`; the two preconfigured Spaces are
`demo-public` (public route class) and `demo-private` (private).

The video Executor needs `ffmpeg` on `PATH`; the PDF Executor also needs
`poppler-utils`.

## Known caveat: the edge dev server does not boot

`pnpm --filter @shutter/edge dev` (and `wrangler dev`) currently fail to start.
`apps/edge/wrangler.jsonc` sets `compatibility_date` `2026-07-10`, but the
workerd bundled by the pinned `@cloudflare/vite-plugin` (miniflare `4.20260701`)
and `wrangler@4.107.1` only supports dates through `2026-07-08`/`2026-07-09`.

This is a runtime-version gap, not a code defect. The Worker is still fully
exercised by:

- `pnpm --filter @shutter/edge build` — vite build producing a deployable Worker
- `pnpm --filter @shutter/edge test` — 17 tests on `vitest-pool-workers`' newer
  workerd (`1.20260706.1`), which does support `2026-07-10`

Running the dev server requires a newer miniflare/workerd (`>= 1.20260706`)
behind the vite plugin and wrangler.

## Repository conventions

- **Edge runtime boundary.** `scripts/check-edge-boundary.mjs` fails the build
  if Worker code imports Node APIs. The Worker runs on Web standards only and
  must not enable `nodejs_compat`.
- **Reviewed infrastructure.** `scripts/check-phase2-config.mjs` guards the R2
  lifecycle rule, the Worker's R2 binding and custom domain, the pinned imgproxy
  image, and the imgproxy SSRF guards.
- **Versioned protocol.** URLs and capabilities carry an explicit `v1`, so
  incompatible drift fails closed rather than degrading. Cross-consumer
  behavior is pinned by fixtures in `@shutter/testkit`.
- **Formatting and linting** are Biome (`pnpm format`).

## Local Effect reference

`repos/effect` is a read-only, gitignored shallow clone pinned to the installed
Effect version. Do not import from or edit it. Run
`node scripts/sync-effect-reference.mjs` to refresh the reference after changing
the pinned Effect version.
