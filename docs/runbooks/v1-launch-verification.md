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

Executors are serverless and may cold-start. Control retries a wake for about
half a minute while a sleeping Executor boots, and the Executor claims a job on
boot, so a cold start normally costs seconds. A `control.dispatch.failed` event
means a whole drain gave up (its `shutter.count` is the attempts made, with the
last HTTP status or error type); the job stays pending for Control's
five-minute sweep, so do not treat one as job loss. The same event every five
minutes for one kind means its Executor is down or misconfigured, not cold.

## Live verification

The old live verifier accepted a caller-provided list of requests and checked
that list against itself. It did not own safe fixtures or prove full behavior.
Use the maintained integration suite for deterministic coverage. Use the
self-hosting runbook for provider evidence, one public Space, one private Space,
and an explicitly disposable purge target. Keep credentials out of shell logs
and the repository.

## Source Purge verification

Run this after any Edge or Control release that touches purge, against one
disposable source on a public Space and one on a private Space. It purges only
those sources. Zone tag purges are limited to 5 a minute per account on the
Free plan, with a burst of 25, so space repeated runs out.

Source Purge clears three stores: R2 (the source's cache and master prefixes),
the Edge's Cache API entries, which live in the zone cache in every data center
that served the source, and the Worker's own Workers Cache, which the Edge does
not enable (ADR 0031). The zone purge by tag is the step that clears the Cache
API entries; an Edge purge call cannot.

1. Confirm the Edge has no Workers Cache: the deployed version was built from an
   `apps/edge/wrangler.jsonc` with no `cache` block. Then probe the Edge purge
   route with a tag that names nothing:

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
     -H "authorization: Bearer $ORIGIN_AUTH_TOKEN" -H 'content-type: application/json' \
     -d '{"tags":["shutter-v1-verification"]}' \
     https://EDGE_DOMAIN/internal/v1/cache/purge
   ```

   Expect `204`. A `503` means the Edge predates the fix that answers `204`
   when the Worker has no cache of its own; every Source Purge fails at that
   step, before the zone purge runs, until that Edge is deployed.
2. Compute the source's tag and fingerprint from a checkout:

   ```sh
   pnpm --filter @shutter/testkit exec node --input-type=module -e \
     'import { buildSourceCacheTag } from "@shutter/protocol"; console.log(await buildSourceCacheTag(process.argv[1], process.argv[2]))' \
     SPACE_ID SOURCE_ID
   ```

   The fingerprint is the tag without `shutter-v1-`; it names the R2 prefixes
   `cache/v1/{public|private}/SPACE_ID/FINGERPRINT/` and
   `masters/v1/SPACE_ID/FINGERPRINT/`, and it is the `sourceHash` of the
   source's log events.
3. Warm every store. Request one optimized URL and the Source Delivery URL for
   the source twice each and record `x-shutter-cache` (`origin` or `r2-hit`,
   then `edge-hit`) and the data center suffix of `cf-ray`. Repeat from a
   second region, such as a CI runner on another continent, until it too reports
   `edge-hit` from a different data center: that copy is the one only a global
   purge can clear. List both R2 prefixes with the read-only Media Store
   credential and confirm objects exist. Wait 30 seconds so the Worker's
   deferred cache and R2 writes have finished.
4. Make the Source Object unavailable in the application's storage, as the
   contract requires, so a later miss cannot render it again.
5. Purge it:

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
     -H "authorization: Bearer $SPACE_API_TOKEN" \
     "https://CONTROL_DOMAIN/v2/spaces/SPACE_ID/sources/$(node -p 'encodeURIComponent(process.argv[1])' SOURCE_ID)/purge"
   ```

   Expect `204`. A `5xx` leaves a `control.purge.failed` event with the
   source's `sourceHash`; repeat the request after the cause is fixed.
6. After about ten seconds, verify from both regions: neither URL reports
   `edge-hit` or `r2-hit` or returns the source's bytes. With the source gone,
   the optimized URL answers `503` and Source Delivery `502`. Both R2 prefixes
   list empty, and Control logged `control.purge.completed` for the
   `sourceHash`.
7. Purge again and expect `204`: the operation is idempotent.
8. For the private source, mint a fresh valid token and repeat step 6: a valid
   token must not recover bytes either.

If a data center still reports `edge-hit` after a `204`, the zone purge did not
reach its Cache API entry: check that `CLOUDFLARE_ZONE_ID` names the zone that
holds the Edge's custom domain and that `CLOUDFLARE_CACHE_PURGE_TOKEN` has the
Zone Cache Purge permission on it. Keep the evidence in the private operational
record.

## Verified configuration inventory (2026-07-12)

- Postgres contains the active Space policies, API-token hashes, and encrypted
  Capability Keys. Control has `SHUTTER_ENCRYPTION_KEY`, the zone ID, and the
  purge token.
- Control and both Executors address the same R2 endpoint and bucket; Executor
  role-token references match Control.
- Control and imgproxy share the signing key, salt, and bearer secret.
  imgproxy has no `S3_*` variable.
- Edge declares `EDGE_CONFIG_TOKEN`, `ORIGIN_AUTH_TOKEN`, and `ORIGIN_BASE_URL`.
  Its snapshot token matches Control, and `MEDIA_STORE` binds to the
  deployment's Media Store bucket.
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
