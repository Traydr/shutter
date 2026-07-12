# Plan 0004: Implement idempotent Source Purge

> **Executor instructions**: Execute only after plan 0003 is DONE. Follow the
> contract order exactly and run every verification command. Update the status
> row in `docs/plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat b53ec3e..HEAD -- apps/control apps/edge packages/protocol .railway/railway.ts docs/contracts/v1/source-purge.md docs/architecture.md`
> Reconcile changes from plan 0003 before editing. Semantic mismatch is a STOP
> condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `docs/plans/0003-complete-master-delivery.md`
- **Category**: correctness / security
- **Planned at**: commit `b53ec3e`, 2026-07-12

## Why this matters

Source Purge is the v1 post-revocation cleanup guarantee. The URL builder and
job deletion primitive exist, but there is no authenticated route or
cross-store orchestration. Without it, cached Renditions, Master Previews, and
job state outlive an application's deletion indefinitely.

## Current state

- `docs/contracts/v1/source-purge.md` defines
  `POST /v1/spaces/{spaceId}/sources/{sourceId}/purge` and the mandatory order:
  invalidate jobs, delete both per-source object prefixes, then globally purge
  the hashed Cloudflare cache tag.
- `packages/protocol/src/urls.ts` already exports `buildSourcePurgeUrl`.
- `packages/protocol/src/cache-identity.ts` exports
  `buildR2CachePurgePrefix`, `buildMasterPurgePrefix`, and
  `buildSourceCacheTag`.
- `apps/control/src/job-store.ts:608-613` has `deleteSource`, but current
  submission/completion/purge serialization must be reviewed and strengthened;
  a bare delete racing completion is insufficient.
- Edge objects carry the hashed source tag. No purge endpoint exists.
- Space API bearer authentication in `apps/control/src/job-api.ts` uses
  constant-time digest comparison; reuse it rather than adding another token
  parser.

Read first:

- `CONTEXT.md` entries for Source ID, Source Purge, Rendition Store, and
  Rendition Job
- `docs/architecture.md` section “Source Purge”
- `docs/contracts/v1/source-purge.md`
- `docs/adr/0008-authorize-before-private-cache-lookups.md`
- `docs/adr/0009-own-generated-rendition-storage.md`
- `docs/adr/0010-separate-cache-eviction-from-derivative-retention.md`
- `docs/adr/0013-separate-space-api-and-capability-credentials.md`

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Control tests | `pnpm test:node` | all Node tests pass |
| Edge tests | `pnpm --filter @shutter/edge test` | all workerd tests pass |
| Full gate | `pnpm check` | exit 0 |
| Railway preview | `railway config plan` | only expected preserved variables/config |

## Scope

**In scope**:

- `apps/control/src/job-api.ts`, job-store/purge modules, and tests
- `apps/edge/src/app.ts`, bindings/config, and workerd tests if Edge owns R2/tag purge
- `packages/protocol` only for missing strict purge request/response helpers
- `.railway/railway.ts` only for non-secret purge configuration
- `docs/plans/0002-shutter-v1-completion.md`

**Out of scope**:

- Capability revocation
- Deleting application-owned Source Objects
- New purge/history database tables
- Background best-effort cleanup after returning success
- Consumer-repository changes or deployments

## Git workflow

- Branch: `codex/002-source-purge`
- Use imperative commits and do not push without instruction.

## Steps

### Step 1: Design serialization around the Source ID

Ensure submission, completion, and purge cannot recreate job state or a Master
Preview after purge wins. Use a Postgres transaction/advisory lock or equivalent
source-scoped serialization compatible with the existing natural key. The
in-memory store must model the same observable behavior for tests.

**Verify**: concurrency tests prove purge versus submission and purge versus
stale completion converge without a job or master output.

### Step 2: Add authenticated purge orchestration

Add the canonical POST route to Control. Require the matching Space API bearer
credential and a known Space. Return `204` only after all phases complete;
return a sanitized retryable `5xx` on partial failure. Missing jobs and objects
remain successful.

**Verify**: route tests cover missing/wrong/cross-Space tokens, encoded Source
IDs, repeat calls, and a failure in each phase.

### Step 3: Delete both object prefixes with pagination

Use the canonical protocol prefix builders. List and delete all objects under
both public/private cache namespaces and the master prefix, handling pagination
and empty pages. Delete R2 objects before any Cloudflare tag purge. Do not build
prefixes by string concatenation in Control.

**Verify**: storage-adapter tests cover more than one page, partial delete
failure, empty prefixes, both route classes, both master kinds, and retry
convergence.

### Step 4: Purge the global Cloudflare source tag

Use a least-privilege Cloudflare API credential kept outside source. Purge only
the tag from `buildSourceCacheTag`; never use purge-everything. Redact account,
token, source, and upstream response details from logs and public errors.

**Verify**: adapter tests assert the hashed tag and sanitized failures. A test
must prove R2 deletion completes before the tag request begins.

### Step 5: Run failure and stale-executor scenarios

Prove that an Executor which uploaded a master but loses processing-token CAS
deletes its output, and that retrying a partial purge is safe. Update milestone
3 in the completion plan only after these pass.

**Verify**: `pnpm check` exits 0.

## Test plan

- Add store-level concurrency tests beside `apps/control/src/job-store.test.ts`.
- Add API tests beside `apps/control/src/job-api.test.ts`.
- Inject R2 and Cloudflare purge clients; tests must not call live services.
- Cover pagination, repeated purge, every partial-failure boundary, stale
  completion, and new submission racing purge.

## Done criteria

- [x] Authenticated canonical purge route returns 204 only after all phases.
- [x] Job invalidation, R2 deletion, and tag purge occur in contract order.
- [x] Partial failure is retryable and repeated calls converge.
- [x] No Source Locator, capability, token, or presigned URL appears in logs.
- [x] No purge/history table was added.
- [x] `pnpm check` exits 0.
- [x] Railway plan was reviewed but not applied.

## STOP conditions

- Plan 0003 did not establish one authoritative Rendition Store.
- Cloudflare tag purge requires broader than tag-scoped access.
- Correct serialization appears to require a new persistent entity or a change
  to the canonical API contract.
- A step fails verification twice.

## Maintenance notes

Purge is cleanup, not instant capability revocation. Reviewers must check the
operation order and concurrency proof, not just the happy-path 204 response.
