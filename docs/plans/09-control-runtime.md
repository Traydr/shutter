# Plan 09 — Control runtime

One PR, after plan 07 (the registry interface should settle before the wiring
that constructs it moves). Give Control a composition module: environment in,
resolved runtime out, with every "feature X is unavailable because Y" decision
made in one place and reported at boot.

## Goal

`apps/control/src/app.ts` registers routes over a runtime it is handed. It
exports `createControlApp` and nothing else. The only import-time composition
in Control is `index.ts`, and the module it calls is tested.

## Why

`app.ts` is 581 lines and the most-changed file in the last month (10 commits).
Lines 479–581 are a 103-line module-level composition root that runs as an
import side effect: `new Pool`, `CapabilityKeyEncryption`,
`PostgresSpaceRegistry`, `EdgeRefreshTracker`, `createMasterStore`,
`new S3Client`, `createSourcePurge`, `jobApiRuntime`, `app`. `app.test.ts`
imports only `createControlApp`, so the exported `app` graph has zero tests.

Five feature-availability decisions are ad-hoc truthiness chains over `env`
(`:506-547`). `sourcePurge` silently becomes `undefined` if any one of six
variables is missing, with no diagnostic; `configuredCapabilityKeyEncryption`
deliberately fails the boot loudly. Both are reasonable policies; the
asymmetry is invisible without reading all 100 lines, and an operator who
misspells `CLOUDFLARE_ZONE_ID` learns about it from a 503 on the first purge.

The same file also carries the two imgproxy proxy routes (`optimizeSource`,
`optimizeMaster`, `:247-443`). They share the sequence "authorize origin →
parse → active policy → imgproxy → stream, log, 502" and share no code.

`sendConfiguredExecutorWake` (`:448-473`) reads `env` directly inside the
request path, so the executor wake tokens are the one dependency the route
layer resolves itself rather than receives.

## Steps

### 1. `runtime.ts`

Add `apps/control/src/runtime.ts` exporting
`buildControlRuntime(env: ServerEnv, deps: { logger; fetch; now })`. It returns:

- `config: ControlRuntimeConfig` for `createControlApp`;
- `jobApiRuntime: JobApiRuntime | undefined` for the recovery sweep;
- `features`: a record naming each optional feature — `spaceRegistry`,
  `jobApi`, `masterStore`, `sourcePurge`, `imgproxy`, `executorDispatch`,
  `admin`, `edgeConfig` — as either `ready` or `{ missing: readonly string[] }`
  listing the environment variables that would enable it;
- `close(): Promise<void>` that ends the pool and the S3 client.

The boot-failure policy lives here and nowhere else: a *supplied but malformed*
value throws (today's `SHUTTER_ENCRYPTION_KEY` rule, extended to a malformed
`DATABASE_URL`); an *absent* value disables the feature and appears in
`features`. `index.ts` logs one `control.service.features` event at startup
listing every non-ready feature and its missing variables.

Construction opens no connections. `pg.Pool` and `S3Client` connect lazily, so
`buildControlRuntime` is a pure assembly step that a test can call with a
literal `ServerEnv`.

### 2. `index.ts` becomes the composition root

```ts
const runtime = buildControlRuntime(env, { logger: controlLogger, fetch, now });
const app = createControlApp(runtime.config);
```

`app.ts` stops exporting `app` and `jobApiRuntime`. `sendConfiguredExecutorWake`
and `dispatchExecutor` move into `runtime.ts`; the wake tokens and base URLs are
resolved once at build time, so `executorDispatch` is a feature like the others
and the Job API receives a `dispatch` that either works or was reported missing
at boot.

`shutdown.ts` calls `runtime.close()` after the server closes.

### 3. Move the imgproxy proxies out

Add `apps/control/src/optimize-routes.ts` with `registerOptimizeRoutes(app,
runtime)`. One internal function owns "active policy or 404/503 → build
imgproxy request → fetch with `redirect: "error"` → stream or 502 with the
`control.optimize.*` events". `optimizeSource` and `optimizeMaster` each become
their parse step plus one call to it. Plan 08's protocol parser removes the
source route's hand parsing; the master route's body validation stays local
until a second consumer appears.

`app.ts` after this step: middleware, error mapping, `healthz`, the two Edge
config endpoints, the admin mount, the Job API mount, and
`registerOptimizeRoutes`. Roughly 250 lines.

### 4. Tests

`runtime.test.ts`:

- a full environment resolves every feature `ready` and produces a
  `jobApiRuntime`;
- an environment with `DATABASE_URL` absent reports `spaceRegistry`, `jobApi`,
  and `sourcePurge` missing and produces `jobApiRuntime === undefined`;
- an environment with every `sourcePurge` input but `CLOUDFLARE_ZONE_ID`
  reports exactly `["CLOUDFLARE_ZONE_ID"]`;
- a malformed `SHUTTER_ENCRYPTION_KEY` throws with the variable name in the
  message;
- `close()` resolves on a runtime whose pool never connected.

`app.test.ts` keeps its route-level cases; the optimize cases move to
`optimize-routes.test.ts` with no behaviour change.

## Verification

Run `pnpm check`. Boot Control locally with `DATABASE_URL` unset and confirm one
`control.service.features` event lists the disabled features. Boot with a
malformed `SHUTTER_ENCRYPTION_KEY` and confirm the process exits before
`serve`.

## Risks

`ControlRuntimeConfig` keeps its 13 fields; this plan moves construction, it
does not redesign the config interface. Shrinking it (folding the token thunks
into one credentials object) is a follow-up if the field count keeps growing.

`migrate.ts` and `import-spaces.ts` also read `env` at import. They are CLI
entry points, not the server, and stay as they are.
