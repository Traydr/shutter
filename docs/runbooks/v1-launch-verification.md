# V1 launch and verification

The operator owns deployment, cutover timing, observation length, rollback, and
provider retirement. These checks do not deploy, switch traffic, or mutate live
data unless the disposable purge mode is explicitly confirmed.

## Deployment order

1. Review `railway config plan`, including the R2 endpoint allowlist and the
   presence of `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_CACHE_PURGE_TOKEN`.
2. Deploy Control, then the video and PDF Executors, then imgproxy.
3. Deploy Edge only after Control health and authenticated origin probes pass.
4. Run `pnpm check`. The maintained Node and Worker integration tests cover
   route transitions, private fail-closed behavior, job recovery, repeated
   purge, and configuration invariants.
5. Follow the live acceptance checklist in
   [self-hosting.md](./self-hosting.md) against disposable sources before
   changing a consumer provider switch.

Executors are serverless and may cold-start. A pending job with a missed wake is
expected to be recovered by Control's five-minute sweep; do not treat one cold
start as job loss.

## Live verification

The old live verifier accepted a caller-provided list of requests and checked
that list against itself. It did not own safe fixtures or prove full behavior.
Use the maintained integration suite for deterministic coverage. Use the
self-hosting runbook for provider evidence, one public Space, one private Space,
and an explicitly disposable purge target. Keep credentials out of shell logs
and the repository.

## Verified configuration inventory (2026-07-12)

- Postgres contains the active Space policies, API-token hashes, and encrypted
  Capability Keys. Control has `SHUTTER_ENCRYPTION_KEY`, the zone ID, and the
  purge token.
- Control and both Executors address the same R2 endpoint and bucket; Executor
  role-token references match Control.
- Control and imgproxy share the signing key, salt, and bearer secret.
- Edge declares `EDGE_CONFIG_TOKEN`, `ORIGIN_AUTH_TOKEN`, and `ORIGIN_BASE_URL`.
  Its snapshot token matches Control, and `DERIVATIVE_STORE` binds to the
  deployment's Derivative Store bucket.
- The live imgproxy allowlist still needs the reviewed Railway IaC update that
  adds the exact R2 hostname before first-request Master Preview rendering.

## Signals and thresholds

- Warn at 70,000 Worker requests per UTC day; treat 90,000 or a trend toward the
  100,000 Free-plan ceiling as the paid-upgrade threshold.
- Alert on private authorization failures returning bytes, sustained origin
  errors, purge failures, retry exhaustion, or job latency beyond the recovery
  and retry contracts.
- Track Edge/R2 hit ratios, imgproxy render volume, Worker CPU, Executor cold
  starts, job duration, and R2 growth. Validate private cache hits remain below
  the 10 ms Worker CPU allowance.
- The initial abuse rule is 300 requests per 10 seconds per client IP with a
  10-second block. It is not an authorization mechanism or exact global budget.

## Rollback checks

Before switching a consumer, confirm its old provider remains selectable. If
authorization, bytes, latency, retries, or purge behavior regress, restore that
consumer's previous provider independently; do not weaken capability checks or
private `no-store` behavior. Keep Shutter jobs and generated objects for
diagnosis unless application deletion requires Source Purge.

Public images, private still images, video posters, and PDF
previews are separate switches. Removing Bunny or an old application path happens
only after the operator's chosen observation period.
