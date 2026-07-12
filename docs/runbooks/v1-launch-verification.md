# V1 launch and verification

The operator owns deployment, cutover timing, observation length, rollback, and
provider retirement. These checks do not deploy, switch traffic, or mutate live
data unless the disposable purge mode is explicitly confirmed.

## Deployment order

1. Review `railway config plan`, including the R2 endpoint allowlist and the
   presence of `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_CACHE_PURGE_TOKEN`.
2. Deploy Control, then the video and PDF Executors, then imgproxy.
3. Deploy Edge only after Control health and authenticated origin probes pass.
4. Run offline verification with `pnpm verify:v1`.
5. Run the opt-in live modes below against disposable sources before changing a
   consumer provider switch.

Executors are serverless and may cold-start. A pending job with a missed wake is
expected to be recovered by Control's five-minute sweep; do not treat one cold
start as job loss.

## Live verification

Live commands fail before network access unless `SHUTTER_VERIFY_LIVE=1` and all
mode-specific variables are present. Values must be supplied through the shell
or secret manager and must not be pasted into logs or committed.

```sh
SHUTTER_VERIFY_LIVE=1 pnpm verify:v1:live -- --mode routes
SHUTTER_VERIFY_LIVE=1 pnpm verify:v1:live -- --mode jobs
SHUTTER_VERIFY_LIVE=1 pnpm verify:v1:live -- --mode recovery
SHUTTER_VERIFY_LIVE=1 pnpm verify:v1:live -- --mode gallery
SHUTTER_VERIFY_LIVE=1 SHUTTER_CONFIRM_DISPOSABLE_PURGE=yes pnpm verify:v1:live -- --mode purge
```

Routes, jobs, and recovery consume a non-empty `SHUTTER_VERIFY_SCENARIOS` JSON
array containing request descriptions and expected status/cache outcomes.
Purge additionally requires `SHUTTER_CONTROL_BASE_URL`, `SHUTTER_SPACE_ID`,
`SHUTTER_SPACE_API_TOKEN`, and an explicitly disposable
`SHUTTER_DISPOSABLE_SOURCE_ID`. Gallery requires `SHUTTER_VERIFY_GALLERY_URL`
and deliberately sends 301 requests.

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

Ernesta public images, Pane View private still images, video posters, and PDF
previews are separate switches. Removing Bunny or an old Pane View path happens
only after the operator's chosen observation period.
