# Shutter v1 completion

## Goal

Complete the remaining v1 delivery, job orchestration, purge, and consumer
integration work without changing the protocol and cache identities locked by
the foundation phase.

## Priority order

1. Replace executor polling with durable, authenticated Control-to-Executor
   dispatch.
2. Finish the public master and private source rendition routes.
3. Implement idempotent Source Purge across the job ledger, R2 prefixes, and
   Cloudflare cache tags.
4. Add recovery, redacted observability, end-to-end tests, and operational
   hardening.
5. Integrate the private application's images, video posters, and PDF previews.

## Milestone 1: executor dispatch

Status: implemented.

Control dispatches a private authenticated wake after accepting a pending job.
The durable job remains accepted if the wake cannot be delivered; the recovery
sweep is responsible for a missed initial dispatch. Each Executor accepts at
most one active invocation per service instance, claims at most one job, and
keeps the wake request open until the attempt records its outcome. A duplicate
wake while work is active returns a successful `busy` result and does not claim
another job.

The five-second polling loops and their deployment variables are removed so the
Railway services can sleep when idle. Control uses each Executor's Railway
private-network address and the existing kind-specific role credential. No new
shared trigger credential is introduced.

The five-minute Control recovery sweep expires pending jobs whose capability
window elapsed, recovers expired processing leases, and re-wakes pending jobs
whose initial dispatch was missed or whose retry delay has elapsed.

Exit criteria:

- A valid pending submission starts one matching Executor invocation.
- Dispatch failure never changes a successfully persisted job response.
- Video credentials cannot wake or claim PDF work, and vice versa.
- Duplicate wakes cannot create concurrent work in one Executor instance.
- No Executor timer polls Control while idle.
- Railway's desired configuration keeps both Executors serverless and supplies
  private wake URLs to Control.

## Milestone 2: complete rendition delivery

Confirmed topology: Cloudflare R2 bucket `shutter-renditions` is the single
authoritative Rendition Store. Executors access that same bucket through its
S3-compatible API and Edge reads it through the `RENDITION_STORE` binding.

Status: implemented.

Implement public master and private source delivery with the same capability,
normalization, cache-identity, R2, imgproxy, and response-header invariants as
the existing routes.

Exit criteria: all five canonical v1 rendition routes pass route-confusion,
capability, cache isolation, normalization, and fail-closed tests.

## Milestone 3: Source Purge

Status: implemented. Production activation requires the non-secret
`CLOUDFLARE_ZONE_ID` and a least-privilege `CLOUDFLARE_CACHE_PURGE_TOKEN` in
Control's Railway environment; the route fails closed while either is absent.

Implement the authenticated, retry-safe purge sequence for both rendition kinds
and every route class. Delete job state, deterministic R2 prefixes, and tagged
Cloudflare cache entries without exposing Source Locators.

Exit criteria: complete, repeated, and partially failed purges converge to the
same empty state.

## Milestone 4: recovery and hardening

Status: implemented. Stable structured events use hashed Source ID and
processing-token correlation, and the offline/live verification commands and
operator launch/rollback runbook are available without changing v1 responses.

Add the recovery runtime, structured redacted logs, gallery-shaped traffic
tests, crash and stale-token coverage, and production end-to-end checks for
Worker, Control, imgproxy, Postgres, R2, and both Executors.

Exit criteria: missed dispatch, delayed retry, expired lease, duplicate wake,
temporary upstream failure, stale completion, and attempt exhaustion all
converge without a second logical job or Master Preview.

## Milestone 5: private application integrations

Integrate private still images first, then video posters and PDF previews. Keep
each provider switch independent and operator-controlled.

Exit criteria: private authorization precedes cache access, renewed
capabilities reuse canonical identities, and materialized preview polling and
failure mapping match the v1 contracts.
