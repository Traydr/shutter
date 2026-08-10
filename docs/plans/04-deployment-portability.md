# Plan 04 — Deployment portability and script cleanup

One later PR, after the registry and admin work. Keep the current Railway
`preserve()` values until this plan is implemented and verified.

## Goal

A self-hoster can supply deployment-specific values without editing Shutter
source. The repository keeps only service topology, safe invariants, and
versioned protocol behavior.

## Scope

### 1. Separate deployment input from product topology

Audit `.railway/railway.ts` and `apps/edge/wrangler.jsonc` for owner-specific
repository names, regions, custom domains, bucket names, and imported volume
names. Keep secrets out of source.

Preserve Railway's TypeScript IaC as the source of desired project topology.
Use Railway product helpers and `preserve()` for existing unknown values. Do not
commit Railway UUIDs or generated domains.

Design and test a fresh-deployment input path before replacing `preserve()`.
Railway can reject a preserved value when no prior value exists, so the plan
must cover both an imported live project and a new self-hosted project.

### 2. Add a human bootstrap path

Use a small setup wizard or documented command only for values that Shutter
cannot derive: domains, provider credentials, region, and storage bindings.
Generate random credentials locally and send them directly to provider secret
stores. Never print them into source files or plan output.

This step must produce a reviewable `railway config plan`. Applying that plan is
an explicit operator action.

### 3. Delete two obsolete scripts

Delete `scripts/check-phase2-config.mjs`. Move still-useful assertions to normal
configuration tests or to the reviewed IaC interface before removing the script.
Delete its package command and update development documentation.

Delete `scripts/verify-v1.mjs` and its package commands. Replace valuable live
checks with maintained integration tests or a runbook; do not keep an offline
manifest that verifies only its own list.

Keep:

- `scripts/check-edge-boundary.mjs`, because it protects the Web-only Edge
  runtime; and
- `scripts/run-workspace-tests.mjs`, because it coordinates the two test
  environments.

### 4. Verify a clean self-host

Create a new Railway project and Cloudflare deployment from the public
repository. Supply only documented deployment inputs. Run `railway config plan`
before any apply, then verify health, one public Space, and one private Space.

## Not in scope

Space policy, protocol constants, and media-route behavior. Those do not become
deployment variables.

## Risk

A generic bootstrap path can overwrite an imported live value if it cannot tell
“new project” from “existing project.” Keep `preserve()` until both paths have
separate tests.
