# Plan 0005: Add redacted observability and production verification

> **Executor instructions**: Start only after plans 0003 and 0004 are DONE. Add
> diagnostics and verification without changing v1 protocol behavior. Update
> `docs/plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat b53ec3e..HEAD -- apps docs/runbooks docs/contracts/v1/operations.md apps/edge/wrangler.jsonc`
> Reconcile completed functional plans before proceeding.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `docs/plans/0003-complete-master-delivery.md`,
  `docs/plans/0004-implement-source-purge.md`
- **Category**: tests / dx / security
- **Planned at**: commit `b53ec3e`, 2026-07-12

## Why this matters

Worker observability is enabled, but application logs are ad hoc and there is
no end-to-end launch evidence for jobs, master delivery, purge, cache behavior,
or traffic limits. Operators need correlated, redacted signals before Pane View
private traffic and materialized previews can migrate.

## Current state

- `apps/edge/wrangler.jsonc:6-12` enables logs and invocation logs at full head
  sampling.
- Control and Executor modules call `console.error`/`console.info` with
  inconsistent fields. Recovery logs counts, but job execution lacks the
  documented hashed source correlation.
- `docs/contracts/v1/operations.md` fixes the Worker warning/critical thresholds
  and gallery-shaped rate-limit test.
- `docs/plans/0001-shutter-foundation.md` phase 10 lists the operator signals:
  Worker request/CPU, cache and R2 hit rates, imgproxy renders, origin errors,
  job latency, retry exhaustion, purge failures, and storage growth.

Read first:

- `CONTEXT.md`
- `docs/contracts/v1/operations.md`
- `docs/contracts/v1/job-execution.md`
- `docs/runbooks/foundation-phase-2.md`
- `docs/adr/0008-authorize-before-private-cache-lookups.md`
- `docs/plans/0001-shutter-foundation.md` phases 7–10

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Full gate | `pnpm check` | exit 0 |
| Edge tests | `pnpm --filter @shutter/edge test` | all pass |
| Node tests | `pnpm test:node` | all pass |

## Scope

**In scope**:

- A small shared-per-runtime logging/correlation helper where it reduces drift
- Control, Edge, and Executor log call sites and tests
- End-to-end scripts that are safe by default and require explicit environment
  variables for live checks
- `docs/runbooks/` launch, rollback, and verification documentation
- `docs/plans/0002-shutter-v1-completion.md`

**Out of scope**:

- A third-party telemetry vendor or OpenTelemetry collector
- Protocol response changes
- Automatic cutover, rollback, or traffic splitting
- Changing Worker plan or rate-limit rules in production
- Consumer repository edits

## Git workflow

- Branch: `codex/003-observability-verification`
- Use imperative commits; do not deploy or push without instruction.

## Steps

### Step 1: Define the redacted event schema

Use stable event names and fields for route/cache outcome, hashed source
identity, rendition kind, execution cycle, attempt number, processing-token
hash, duration, and sanitized failure code. Never log capabilities, locators,
presigned URLs, tokens, command lines, stderr, or raw Source IDs. Keep helpers
runtime-specific if sharing would pull Node APIs into Edge.

**Verify**: unit tests snapshot allowed key names and prove forbidden values do
not appear.

### Step 2: Instrument critical paths

Cover Edge cache outcomes and origin failures; Control submission, dispatch,
recovery, completion, and purge; Executor claim, processing result, stale CAS,
and retry classification. Avoid logging every heartbeat.

**Verify**: focused tests assert event names and redaction without depending on
console output order.

### Step 3: Add safe end-to-end checks

Create scripts/runbook commands for:

- all five route classes and cache transitions;
- tampered/expired/wrong-purpose private requests returning no bytes;
- video and PDF job submit/poll/ready flows;
- missed dispatch and retry recovery;
- repeated Source Purge;
- gallery-shaped traffic under the documented initial rate rule.

Scripts must fail closed when required environment variables are absent and
must never print their values. Destructive purge tests require an explicit
disposable Source ID and confirmation flag.

**Verify**: offline/unit mode passes without network. Live mode is documented
but not run unless the operator authorizes it.

### Step 4: Write the operator runbook

Document expected dashboards/signals, alert thresholds, cold-start behavior for
serverless Executors, deployment order, rollback checks, and provider switches.
State that the operator owns cutover timing.

**Verify**: every command in the runbook exists and `pnpm check` exits 0.

## Test plan

- Unit-test redaction with representative sensitive-shaped strings without
  using real secrets.
- Test cache-event classification in workerd.
- Test job correlation and failure mapping in Node.
- Keep live smoke checks opt-in and separate from `pnpm check`.

## Done criteria

- [x] Every critical path emits a stable redacted event.
- [x] Tests prove forbidden sensitive fields are absent.
- [x] Offline end-to-end verification is repeatable.
- [x] Operator runbook covers launch signals and rollback checks.
- [x] No vendor-specific telemetry dependency was added.
- [x] `pnpm check` exits 0.

## STOP conditions

- Correlation would require storing a new identifier in Postgres.
- A logging library would enter the Worker graph with Node dependencies.
- A live verification step would mutate production without explicit approval.
- A step fails verification twice.

## Maintenance notes

After this plan, the next agent should move to Pane View integration in the
order private still images, video posters, then PDF previews. Keep each provider
switch independent and operator-controlled as specified in roadmap phases 7–9.
