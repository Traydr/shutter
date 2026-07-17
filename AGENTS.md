# AGENTS.md

## Cursor Cloud specific instructions

Shutter is a private TypeScript pnpm workspace (Node 22, pnpm 11.1). Standard
commands live in the root `package.json` and `README.md`
(`pnpm install --frozen-lockfile`, `pnpm check` = `lint` + `typecheck` + `test` +
`build`). The notes below cover only non-obvious caveats discovered while setting
up the environment.

### Node version gotcha (affects edge/vite builds)

`/exec-daemon/node` is Node **v22.14.0**, which lacks `node:module.registerHooks`
that `vite` / `@cloudflare/vite-plugin` require. The nvm default is **v22.22.2**
(satisfies the repo's `>=22.13.0 <23` engine and has `registerHooks`). A snippet
appended to `~/.bashrc` prepends the nvm Node bin to `PATH`, so **login/interactive
shells (including tmux `bash -l`) automatically resolve v22.22.2**. If a
non-login shell picks up v22.14.0 and a build fails with
`does not provide an export named 'registerHooks'`, prepend the right Node first:
`export PATH="$(dirname "$(nvm which default)"):$PATH"`.

### Node tests require Docker (Postgres testcontainers)

`pnpm test` / `pnpm test:node` start a `postgres:17-alpine` container via
`@testcontainers/postgresql` (`apps/control/src/postgres-test-global.ts`). Docker
is installed but the daemon is not auto-started. Start it once per session and
make the socket usable:

```sh
sudo dockerd >/tmp/dockerd.log 2>&1 &   # wait until `docker info` succeeds
sudo chmod 666 /var/run/docker.sock     # allow non-sudo docker (testcontainers)
```

Without a running daemon, only `test:node` is affected; lint, typecheck, build,
and the worker tests do not need Docker.

Cloudflare Workers Builds sets `WORKERS_CI=1` and has no Docker/cgroup support, so
`pnpm check` / `pnpm test` skip `test:node` there and still run worker tests plus
the rest of the gate.

### Edge worker local dev is version-blocked (build + tests still work)

`pnpm --filter @shutter/edge dev` (and `wrangler dev`) currently **fail to boot**:
`apps/edge/wrangler.jsonc` sets `compatibility_date` `2026-07-10`, but the workerd
bundled by the pinned `@cloudflare/vite-plugin` (miniflare `4.20260701`) and
`wrangler@4.107.1` only supports dates up to `2026-07-08`/`2026-07-09`. This is a
runtime-version gap, not a code bug. The edge Worker is still fully validated by:

- `pnpm --filter @shutter/edge build` (vite build → deployable worker), and
- its 16 worker tests (`pnpm --filter @shutter/edge test`), which run on
  `vitest-pool-workers`' newer workerd (`1.20260706.1`, which does support
  `2026-07-10`).

To actually run the edge dev server, a newer `miniflare`/`workerd` (>= `1.20260706`)
must back the vite plugin / wrangler.

### Running the services (dev mode)

Node services are Hono servers with a `/healthz` endpoint and are **fail-closed**
(routes return 401/503 until their env is configured). Ports are set via `PORT`.

- `pnpm --filter @shutter/control dev` — Control plane + Rendition Job API.
- `pnpm --filter @shutter/executor-video dev` / `@shutter/executor-pdf dev`.
- `pnpm --filter @shutter/edge dev` — see the version caveat above.

To exercise the Control Rendition Job API end-to-end you need Postgres plus these
env vars (see `apps/control/src/app.ts`): `DATABASE_URL`, `SPACE_API_TOKENS`
(JSON, tokens must be >= 32 chars), and `CAPABILITY_KEYS` (JSON of 32-byte keys,
hex or base64url). Run migrations first with
`DATABASE_URL=... pnpm --filter @shutter/control db:migrate`. Source Capabilities
for job submission can be minted with `issueSourceCapability` from
`@shutter/protocol`; the capability `locator` origin must be allowlisted by the
target Space (`packages/space-config`). Preconfigured Spaces: `ernesta` (public),
`pane-view` (private).
