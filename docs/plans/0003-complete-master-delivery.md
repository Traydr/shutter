# Plan 0003: Reconcile the Rendition Store and complete master delivery

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Stop
> at the storage checkpoint until the operator confirms the deployed topology.
> When done, update this plan's row in `docs/plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat b53ec3e..HEAD -- apps/edge apps/control apps/executor-video apps/executor-pdf packages/protocol .railway/railway.ts docs/architecture.md docs/adr/0019-store-renditions-in-r2.md docs/contracts/v1/rendition-urls.md`
> If these files changed, compare the current state below with live code before
> proceeding. A semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: direction / correctness
- **Planned at**: commit `b53ec3e`, 2026-07-12

## Why this matters

The public master route is the only canonical v1 rendition route not present.
Private master delivery also fails on the first normalized-size miss because
imgproxy has no authenticated HTTPS way to read the stored Master Preview.
More importantly, the documented R2 topology and deployed generic S3 variables
may describe different buckets. Writing a Master Preview to one store while the
Edge reads another makes both master routes impossible and would make purge
incomplete.

## Current state

- `docs/adr/0019-store-renditions-in-r2.md` and
  `docs/contracts/v1/source-purge.md` declare Cloudflare R2 as the single
  Rendition Store. Executors must write through R2's S3-compatible API and the
  Worker must read the same bucket through its native binding.
- `apps/edge/wrangler.jsonc:20-24` binds `RENDITION_STORE` to the
  `shutter-renditions` R2 bucket.
- `.railway/railway.ts:20-30` preserves generic `S3_*` variables and passes them
  to Control, imgproxy, and both Executors. Their actual values are deliberately
  absent from source.
- `apps/executor-video/src/run-once.ts` and
  `apps/executor-pdf/src/run-once.ts` upload the deterministic key returned by
  `buildMasterPreviewKey` through their configured S3 client.
- `apps/edge/src/app.ts:165-188` can resize a private source when a locator is
  present, but throws when a master-sized rendition is absent because no master
  source locator exists.
- `apps/edge/src/app.ts` has no
  `/v1/public/:spaceId/master/:kind/:sourceId` handler.
- `apps/control/src/app.ts:53-117` accepts an HTTPS source URL and calls signed
  imgproxy, but cannot derive an authenticated temporary URL for a stored
  Master Preview.
- The canonical URL, cache key, master key, and tag builders already exist in
  `packages/protocol/src/urls.ts` and
  `packages/protocol/src/cache-identity.ts`; reuse them exactly.

Relevant decisions and contracts:

- `CONTEXT.md`: Source ID is identity; Source Locator is replaceable location;
  a Master Preview is one durable quality-90 WebP Derivative.
- `docs/adr/0008-authorize-before-private-cache-lookups.md`
- `docs/adr/0009-own-generated-rendition-storage.md`
- `docs/adr/0012-materialize-one-master-preview.md`
- `docs/adr/0014-use-cloudflare-as-edge-and-railway-as-origin.md`
- `docs/adr/0015-separate-public-and-private-rendition-paths.md`
- `docs/adr/0019-store-renditions-in-r2.md`
- `docs/contracts/v1/rendition-urls.md`
- `docs/contracts/v1/source-capability.md`

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Edge tests | `pnpm --filter @shutter/edge test` | all workerd tests pass |
| Control tests | `pnpm test:node` | all Node tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Full gate | `pnpm check` | exit 0 |
| Railway preview | `railway config plan` | only reviewed intended changes |

Use the `railway-config` skill when editing `.railway/railway.ts`. Do not apply
the resulting plan.

## Scope

**In scope**:

- `apps/edge/src/app.ts`
- `apps/edge/src/edge.worker.test.ts`
- `apps/control/src/app.ts` and its tests
- A focused Control storage/presigning module and test, if required
- `apps/control/package.json`, `pnpm-lock.yaml`
- Executor storage configuration only if needed to restore the R2 topology
- `.railway/railway.ts`
- `docs/plans/0002-shutter-v1-completion.md`
- Contract or ADR corrections only after explicit operator confirmation of a
  deliberate topology change

**Out of scope**:

- Source Purge (plan 0004)
- Pane View or Ernesta changes
- Public exposure of Master Preview objects
- Caller-selected transformations or output formats
- Deploying or applying infrastructure

## Git workflow

- Branch: `codex/001-complete-master-delivery`
- Use small imperative commit messages consistent with recent history.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Confirm one physical Rendition Store

Ask the operator to confirm, without pasting credentials, whether the deployed
Executor `S3_*` variables address the exact Cloudflare R2 bucket bound to the
Worker as `RENDITION_STORE`.

- If yes, record the non-secret topology (provider and bucket identity only) in
  `docs/plans/0002-shutter-v1-completion.md` and continue.
- If no, STOP. Recommend restoring Executors and Control to R2-compatible
  credentials to match ADR-0019. Do not silently redesign Shutter around a
  Railway bucket, copy objects between stores, or amend an ADR without operator
  approval.

**Verify**: operator confirmation exists and no credential values appear in the
working tree or terminal transcript included in commits.

### Step 2: Add an authenticated master-source bridge

Implement the smallest server-side path that lets Control give imgproxy a
short-lived, HTTPS, read-only URL for the deterministic Master Preview key.
Recommended shape when R2 remains authoritative:

1. Control derives the key with `buildMasterPreviewKey`; it never accepts a raw
   caller-selected object key.
2. A focused storage adapter creates a short-lived presigned `GET` for that key
   using dedicated R2 S3 credentials supplied only to Control and Executors.
3. Control passes the temporary HTTPS URL to existing signed imgproxy logic.
4. Origin authentication remains `ORIGIN_AUTH_TOKEN`; public clients cannot
   call the bridge directly.
5. Logs must not contain the presigned URL, Source Locator, capability, or raw
   credential.

Prefer a strict JSON `POST` body for the Edge-to-Control request rather than
putting sensitive locators in a query string. Keep the existing source-origin
route compatible until all callers and tests move, then rename it away from the
`spike` path if that can be done inside this scope.

**Verify**: focused Control tests prove bearer rejection, strict body parsing,
deterministic master-key derivation, a bounded presign expiry, and redacted
errors.

### Step 3: Complete private master misses

Change `privateRendition` so a validated `master_preview` request checks the
private canonical Cache API entry, then R2 optimized cache, then invokes the
master bridge on a miss. Capability verification must remain before every cache
lookup. Browser responses stay `private, no-store`; the internal cache entry
keeps the 24-hour TTL.

**Verify**: workerd tests cover valid miss, R2 hit, edge hit, expired/tampered/
wrong-purpose capability rejection before bytes, and cache reuse across token
renewal.

### Step 4: Implement the public master route

Add exactly:

`GET /v1/public/{space}/master/{kind}/{sourceId}?w={width}&q={quality}`

Require a public Space and kind `video` or `pdf`. Apply the same public
normalization redirect and canonical query ordering as the resolver route. Use
the public master cache identity (`input: { type: "master", kind }`), public
cache headers, source tag, R2 fallback, and master bridge on miss. There is no
capability on this route.

**Verify**: workerd tests cover both kinds, encoded Source IDs, non-canonical
redirects, wrong route class, bad kind, miss-to-origin, R2 hit, edge hit, and
separation from source/private cache identities.

### Step 5: Align Railway desired state

Use distinct, clearly named preserved variables for the R2 S3 endpoint, bucket,
region, access key, and secret if the generic `S3_*` names could still point to
application storage. Keep secrets out of source. Add only the exact imgproxy
allowlist origin required for presigned R2 reads.

**Verify**: `railway config plan` proposes only the reviewed variable/reference
changes. Do not run `railway config apply`.

### Step 6: Run the full gate and update status

Run `pnpm check`. Update milestone 2 in
`docs/plans/0002-shutter-v1-completion.md` to implemented only after all five
routes pass.

## Test plan

- Model Edge tests after `apps/edge/src/edge.worker.test.ts` private-source and
  private-master tests.
- Model Control authentication tests after `apps/control/src/app.test.ts`.
- Never make unit tests depend on live R2, Railway, or Cloudflare credentials;
  inject the presigner/storage boundary.
- Add one production-like manual smoke checklist, but do not execute deployment
  commands without authorization.

Manual smoke checklist after deployment authorization:

- Submit one disposable video job and one disposable PDF job and wait for ready
  descriptors.
- Request each public and private Master Preview at a size not already cached;
  confirm `origin`, then `edge-hit`, and compare the returned WebP dimensions.
- Renew the private capability and confirm it reuses the same canonical cache
  entry while an expired or tampered capability returns no bytes.
- Confirm the generated optimized objects and durable masters exist only in the
  `shutter-renditions` bucket and that no presigned URL appears in logs.

## Done criteria

- [x] The operator confirmed one authoritative R2 store.
- [x] Executors write Master Previews to the bucket the Worker reads.
- [x] Public and private master first requests render through imgproxy.
- [x] All five v1 rendition routes have miss, R2-hit, and applicable edge-hit tests.
- [x] Private capability checks precede every private cache read.
- [x] No sensitive URL or credential is logged.
- [x] `pnpm check` exits 0.
- [x] `railway config plan` contains only expected changes and was not applied.
- [x] Only in-scope files changed, apart from `docs/plans/README.md` status.

## STOP conditions

- Deployed `S3_*` variables point to a different provider/bucket than the R2
  binding.
- The solution appears to require making Master Previews public.
- imgproxy cannot fetch a presigned R2 HTTPS URL under the configured safety
  policy.
- A contract or ADR must change to proceed.
- Verification fails twice after a reasonable correction.

## Maintenance notes

Source Purge must use the same resolved store and prefixes. Reviewers should
scrutinize capability-before-cache ordering, presign expiry, cache identity,
and logs. Do not merge a route that works only when an optimized cache object
was pre-populated.
