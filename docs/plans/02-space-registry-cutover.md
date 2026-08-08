# Plan 02 — Space registry cutover

One PR, depending on plan 01. Control reads Spaces from the database, the Edge
reads them from an environment variable, the Executors stop reading them at all,
and the tenant data leaves the repository.

## Goal

`packages/space-config` is deleted. No tenant identifier appears anywhere in the
tree. The live deployment migrates without downtime.

## Not in scope

The admin surface. Until plan 03 lands, Spaces are managed with the import
script and direct SQL. That is acceptable for a deployment with two Spaces and
keeps this PR reviewable.

## Steps

### 1. Space registry in Control

An in-memory registry loaded at boot from the plan 01 repository functions and
invalidated on write. It exposes the same synchronous
`getSpacePolicy(spaceId): SpacePolicy | undefined` signature the call sites
already use, which is what keeps this diff small — the four call sites change
their import, not their shape:

- `apps/control/src/app.ts:169`
- `apps/control/src/job-api.ts:109`, `:126`, `:213`

Control runs a single replica (`replicas: { [region]: 1 }` in
`.railway/railway.ts`), so an in-process cache needs no cross-replica
invalidation. Record this as a constraint in `docs/architecture.md`: raising the
replica count requires a real invalidation path first.

If the registry cannot load at boot — no database, no rows — Control starts and
every Space-scoped route returns 404 or 503. It must not fall open.

### 2. API token verification

`authorizedSpace()` in `apps/control/src/job-api.ts` currently compares against
the parsed `SPACE_API_TOKENS` environment variable. Point it at the plan 01
token verification instead. Remove `SPACE_API_TOKENS` from
`apps/control/src/env/server.ts`, `.env.example`, and `.railway/railway.ts`.

`CAPABILITY_KEYS` stays in Control's environment for now only if the import
script still needs it; otherwise it is removed here too and read from the
database.

### 3. Executors stop reading policy

`packages/executor-runtime/src/index.ts:91` loads a whole policy and uses only
`policy.allowedSourceOrigins`, for a claim Control has just issued. Put that
array in the claim payload:

- Extend the claim type in `packages/protocol/src/jobs.ts`.
- Populate it in `apps/control/src/job-api.ts:213`, which already has the policy
  in hand.
- Consume it in `packages/executor-runtime/src/index.ts`, deleting the import at
  line 16 and the lookup and its `configuration_error` branch.
- Update `docs/contracts/v1/job-execution.md`.
- Remove `@shutter/space-config` from `packages/executor-runtime/package.json`
  and drop `/packages/space-config/**` from `executorWatchPatterns` in
  `.railway/railway.ts`.

The Executors then have no Space configuration at all.

### 4. Edge reads `SPACE_POLICIES`

The Worker parses the plan 01 schema from a new `SPACE_POLICIES` environment
variable, cached by raw string in the isolate exactly as `keyRegistryCache`
already does for `CAPABILITY_KEYS` at `apps/edge/src/app.ts:26-51`. The six
`getSpacePolicy` call sites — lines 251, 386, 432, 459, 483, and 515 — change
their import only.

Add `SPACE_POLICIES` to the required secrets in `apps/edge/wrangler.jsonc` and
to `apps/edge/.dev.vars.example`. A missing or unparseable value yields 404 on
every Space-scoped route.

### 5. Import script

A one-shot script that reads the existing `SPACE_API_TOKENS` and
`CAPABILITY_KEYS` environment variables plus the policies being deleted, and
writes the corresponding rows. This is what migrates the live deployment without
retyping secrets or invalidating capabilities already in browsers.

Run it once against production after deploy, then confirm the rendered
`SPACE_POLICIES` matches what the Worker already has before removing anything.

### 6. Delete `packages/space-config`

Remove the package, its entry in `pnpm-workspace.yaml`, its dependency in
`apps/edge/package.json`, `apps/control/package.json`, and
`packages/executor-runtime/package.json`, and its root in
`scripts/check-edge-boundary.mjs`.

### 7. Test fixtures

Thirteen files assert the literal tenant identifiers and must move to a
`fixtureSpaces()` helper in `packages/testkit`. This is the bulk of the diff:

```
apps/control/src/app.test.ts
apps/control/src/imgproxy.test.ts
apps/control/src/job-api.test.ts
apps/control/src/recovery.test.ts
apps/control/src/rendition-job-lifecycle.test.ts
apps/control/src/source-purge.test.ts
apps/edge/src/edge.worker.test.ts
apps/edge/vitest.config.ts
packages/executor-runtime/src/index.test.ts
packages/protocol/src/cache-identity.test.ts
packages/protocol/src/key-material.test.ts
packages/protocol/src/observability.test.ts
packages/space-config/src/index.test.ts   (deleted)
```

The fixtures use obviously fake values — `example-public`, `example-private`,
`https://sources.example.com` — so that a future leak of this kind is visible on
sight.

### 8. imgproxy allowlist scope

`IMGPROXY_ALLOWED_SOURCES` cannot follow the database: it is read by the
imgproxy container at process start. Redefine it as a *deployment-level* guard —
the origin families this instance will ever fetch from — rather than per-Space
policy, which now lives in the registry and is enforced by Control before it
signs (`apps/control/src/imgproxy.ts`) and by the Edge before it delivers.

Keep it. Do not open it to all sources. The private-address guards
(`IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES`,
`IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES`,
`IMGPROXY_ALLOW_LINK_LOCAL_SOURCE_ADDRESSES`, all `"false"`) become
load-bearing if it is ever widened, and it is not confirmed that imgproxy's
private-address check covers the IPv6 unique-local range Railway's private
network uses. Verify that before considering it.

### 9. Scripts

`scripts/check-phase2-config.mjs` is not an artifact despite its name — it runs
in `pnpm lint` and enforces the ADR-0020 lifecycle rule, the native R2 binding,
the absence of `nodejs_compat`, and the pinned imgproxy image. Rename it to
`check-deployment-invariants.mjs`, update `lint:phase2-config` in
`package.json`, and reword its `IMGPROXY_ALLOWED_SOURCES` assertion for the
narrowed meaning in step 8.

`scripts/check-edge-boundary.mjs` and `scripts/run-workspace-tests.mjs` stay as
they are, minus the deleted `space-config` root.

`scripts/verify-v1.mjs` is not wired into `pnpm check` and is the one script
that fits the "leftover" description. Deleting it is a separate decision from
this plan.

### 10. Documentation

- Rewrite `docs/architecture.md:151-166`, which currently states that Spaces are
  static deployment configuration.
- Fix `README.md:341`, which describes the committed Spaces as illustrative.
- Fix `docs/runbooks/foundation-phase-2.md`, which names `demo-project-1` and
  `demo-project-2`.
- New ADR superseding static Space configuration.
- New ADR narrowing the imgproxy allowlist to deployment scope, recording that
  the signature requirement and the private-address guards are what it now
  relies on.

## Verification

`pnpm check` passes. Beyond the suite: bring up Control with an empty database
and confirm every Space route 404s rather than falling open; run the import
script against a copy of production and diff the rendered `SPACE_POLICIES`
against the current Worker secret; confirm a capability minted before the
migration still verifies after it.

## Risks

**Import correctness is the whole risk.** A capability key that does not survive
the round trip breaks every private image URL in flight for up to 24 hours.
Diff the rendered output against the live Worker secret before cutting over, and
keep the old environment variables set until the diff is clean.

**Fixture churn hides regressions.** Thirteen files changing at once makes
review hard. Land the fixture helper and mechanical renames as the first commit
in the PR, so the behavioural commits read separately.
