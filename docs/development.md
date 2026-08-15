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
stack up one capability at a time. Control reports what it could not enable in
one `control.service.features` event at startup, naming each disabled feature
and the variables that would enable it; a variable that is set but malformed
(such as a bad `SHUTTER_ENCRYPTION_KEY` or a non-Postgres `DATABASE_URL`) fails
the boot instead.

Control reads configuration only through `apps/control/src/env/server.ts`;
production modules do not touch `process.env` directly.

## Running the services

Each Node service is a Hono server with a `/healthz` endpoint, and its port
comes from `PORT`.

```sh
pnpm --filter @shutter/control dev         # control plane + Preview Job API
pnpm --filter @shutter/executor-video dev
pnpm --filter @shutter/executor-pdf dev
pnpm --filter @shutter/edge dev            # see the caveat below
```

To exercise the Preview Job API end to end you need Postgres plus
`DATABASE_URL` and `SHUTTER_ENCRYPTION_KEY`. Run migrations first:

```sh
DATABASE_URL=... pnpm --filter @shutter/control db:migrate
```

Create a Space, API token, and Capability Key in the Space Registry before you
submit a job — either through one-shot import
(`DATABASE_URL=... SHUTTER_ENCRYPTION_KEY=... pnpm --filter @shutter/control
db:import-spaces <input.json>`, input format in
`docs/runbooks/foundation-phase-2.md`) or through the `/admin` surface once it
is configured. Mint Source Capabilities with `issueSourceCapability` from
`@shutter/protocol`. A capability's `locator` origin must be allowed by the
target Space record.

For local operator flows, set an `ADMIN_BOOTSTRAP_TOKEN` with at least 32
characters alongside `DATABASE_URL` and `SHUTTER_ENCRYPTION_KEY`, then open
`https://<control-origin>/admin`. The session cookie is
always Secure, so use an HTTPS local proxy or exercise the interface through
the tests. Set `IMGPROXY_ALLOWED_SOURCES` on Control to let the dashboard compare
the deployed imgproxy guard with active Space origins.

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
- `pnpm --filter @shutter/edge test` — Worker tests on `vitest-pool-workers`' newer
  workerd (`1.20260706.1`), which does support `2026-07-10`

Running the dev server requires a newer miniflare/workerd (`>= 1.20260706`)
behind the vite plugin and wrangler.

## Repository conventions

- **Edge runtime boundary.** `scripts/check-edge-boundary.mjs` fails the build
  if Worker code imports Node APIs. The Worker runs on Web standards only and
  must not enable `nodejs_compat`.
- **Reviewed infrastructure.** Normal configuration tests guard the R2
  lifecycle rule, the seeded and unseeded Railway graphs, the Worker's R2
  binding, the pinned imgproxy image, and the imgproxy SSRF guards. The
  [self-hosting runbook](./runbooks/self-hosting.md) covers deployment values.
- **Versioned protocol.** URLs and capabilities carry an explicit `v1`, so
  incompatible drift fails closed rather than degrading. Cross-consumer
  behavior is pinned by fixtures in `@shutter/testkit`.
- **Formatting and linting** are Biome (`pnpm format`).
