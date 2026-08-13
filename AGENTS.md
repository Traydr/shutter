# AGENTS.md

Shutter is a TypeScript pnpm workspace (Node 22, pnpm 11.1). Setup, commands,
configuration, how to run each service, and the repository conventions are in
**[docs/development.md](./docs/development.md)** — read that first. The domain
vocabulary is in [CONTEXT.md](./CONTEXT.md); the architecture and its decision
records are in [docs/architecture.md](./docs/architecture.md) and
[docs/adr/](./docs/adr/).

## Before you finish

Run `pnpm check` (`lint` + `typecheck` + `test` + `build`). It needs a running
container runtime for the Control tests; see docs/development.md.

## Invariants worth restating

These are enforced by lint rules or tests, so breaking them fails the build
rather than showing up in review.

- The edge Worker runs on Web standards only. No Node imports, no
  `nodejs_compat` (`scripts/check-edge-boundary.mjs`).
- Reviewed infrastructure in `.railway/railway.ts`, `apps/edge/wrangler.jsonc`,
  and the R2 lifecycle rule is guarded by normal configuration tests.
  Deployment-specific values stay in the ignored deployment input or use
  `preserve()` for imported projects; they are never committed.
- Control reads configuration only through `apps/control/src/env/server.ts`.
- Protocol changes are fixture changes. Cross-consumer behavior is pinned in
  `@shutter/testkit`, and URLs and capabilities carry an explicit `v1`.
- Logging is allowlisted and redacted. Never add raw paths, queries, headers,
  bodies, locators, capabilities, Source IDs, or error messages to an event.

## Environment-specific notes

If a sandbox ships an older Node than `.node-version` requires, `vite` and
`@cloudflare/vite-plugin` fail with `does not provide an export named
'registerHooks'`. Put a Node that satisfies `>=22.13.0 <23` on `PATH` first.

Where the Docker daemon is not auto-started, start it before `pnpm test:node`
and make the socket usable by the test process, for example:

```sh
sudo dockerd >/tmp/dockerd.log 2>&1 &   # wait until `docker info` succeeds
sudo chmod 666 /var/run/docker.sock
```
