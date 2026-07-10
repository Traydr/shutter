# Shutter foundation

## Goal

Replace Bunny image optimization and Pane View's current media-derivative path
with a focused rendition service. Ernesta and Pane View continue to own uploads,
Source Objects, media records, retention, and end-user authorization. Shutter
owns only generated Renditions and the operational video/PDF job ledger.

## V1 outcome

- Width-only WebP Image Optimization at Space-approved qualities.
- Public resolver, public located-source, public master, private source, and
  private master delivery routes.
- Authorization before every private edge-cache lookup and `no-store` private
  browser responses.
- One durable quality-90 Master Preview per video or PDF Source Object.
- Separate video and PDF Executors with bounded retries and polling completion.
- Cloudflare Worker and CDN delivery, R2 Rendition Store, and Railway-hosted
  Control, Postgres, imgproxy, and Executors.
- No uploads, media catalog, Asset records, source registration, webhooks, or
  npm-published SDK.

## Repository shape

```text
apps/
  edge/                 Cloudflare Hono Worker
  control/              Railway Hono API and Drizzle migrations
  executor-video/       Railway video Master Preview worker
  executor-pdf/         Railway PDF Master Preview worker
packages/
  protocol/             Web-standard types, URLs, policy, and capability crypto
  space-config/         Checked-in non-secret Space policies
  testkit/              Cross-runtime fixtures and conformance helpers
infra/
  imgproxy/             imgproxy deployment configuration
```

Workspace packages are private and are not published to npm. Consumer
repositories keep thin local adapters and run Shutter-owned conformance fixtures.

## Delivery phases

### 1. Lock protocol and scaffold the workspace

- Create the TypeScript pnpm workspace and the four independently deployable
  apps above.
- Encode the v1 routes, capability union, width/quality policy, cache keys,
  failure codes, and job representations in `packages/protocol`.
- Add static Ernesta and Pane View Space policies; put keys and credentials only
  in Cloudflare and Railway secret stores.
- Generate Node and workerd-compatible AES-GCM fixtures and URL-normalization
  fixtures. Reject incompatible drift with explicit v1 versions.
- Establish lint, typecheck, unit-test, and build commands for the whole
  workspace.

Exit criteria: Node and workerd pass the same capability and canonicalization
fixtures; no package imports Node APIs into the Worker graph.

### 2. Prove the Cloudflare, R2, Railway, and imgproxy path

- Create the R2 Rendition Store with separate `cache/` and `masters/` prefixes;
  apply the 30-day lifecycle only to cache objects.
- Deploy a minimal Worker with native R2 and Cache API bindings and fail-closed
  capability routes.
- Deploy imgproxy privately on Railway with signed processing URLs, an internal
  bearer credential, and the global source-safety ceilings.
- Protect the Railway origin with a Worker/origin credential and prove direct
  unauthenticated access fails.
- Verify public CDN caching, private canonical Cache API entries, public located
  capability exclusion, R2 fallback, cache tags, and global Source Purge.
- Measure AES-GCM plus cache-hit CPU against Workers Free's 10 ms allowance and
  exercise the 300-request/10-second rate-limit rule against gallery-shaped
  traffic.

Exit criteria: the spike passes every item in the CDN research checklist and
demonstrates that no private byte is returned before capability validation.

### 3. Implement on-demand Image Optimization

- Implement all five canonical rendition routes from `rendition-urls.md`.
- Resolve UploadThing public references through the trusted Ernesta resolver;
  reject arbitrary unsigned URLs and unallowlisted projects.
- Validate typed capabilities, Space route class, Source ID, expiry, purpose,
  locator origin, and source limits.
- Normalize width and quality, build signed imgproxy requests, encode WebP, and
  prohibit height, crop, filters, enlargement, and caller-selected format.
- Store generated variants under deterministic per-source R2 keys and tag every
  edge response for Source Purge.
- Apply public 1-day browser/30-day edge headers and private browser `no-store`
  with a separate 24-hour internal edge entry.

Exit criteria: representative landscape, portrait, small, large, and animated
fixtures produce correct widths, composition, qualities, headers, cache keys,
and first-frame behavior.

### 4. Implement Control and the single job ledger

- Create only the `rendition_jobs` Drizzle schema defined by `job-ledger.md`.
- Implement authenticated idempotent job `PUT`, polling `GET`, executor claim,
  heartbeat, completion, retry, and recovery transitions.
- Enforce the natural `(space_id, source_id, kind)` identity and processing-token
  comparisons.
- Return `202` plus `Location` and `Retry-After` while active, stable ready
  descriptors when complete, and sanitized failure codes/actions on failure.
- Implement the idempotent Source Purge sequence across jobs, R2 prefixes, and
  Cloudflare cache tags.
- Emit structured, redacted logs correlated by hashed source identity, kind,
  execution cycle, attempt, and processing token.

Exit criteria: concurrency, missed dispatch, expired leases, stale completion,
partial purge, `source_expired`, and `attempts_exhausted` tests pass without a
second logical job or Master Preview.

### 5. Implement separate video and PDF Executors

- Give each Executor a distinct role credential and claim only its own job kind.
- Receive a validated Source Locator from Control without capability keys,
  download within type limits, and keep the locator only in process memory.
- Video: capture at one second with first-decodable-frame fallback.
- PDF: render page one and reject encrypted/password-protected input.
- Encode a composition-preserving WebP at quality 90 within 1920 pixels and
  write the deterministic master key to R2.
- Complete through the processing-token comparison and delete a stale upload if
  completion loses its compare-and-set race.
- Enforce five attempts per execution cycle, fixed backoff, lease, heartbeat,
  hard timeout, and recovery sweep contracts.

Exit criteria: each Executor survives crashes, duplicate wakes, temporary source
and R2 failures, stale tokens, and deterministic bad input without corrupting
job or Master Preview identity.

### 6. Migrate Ernesta public images

- Add a local Shutter Unpic adapter using the canonical width ladder and Ernesta
  quality set. Do not change UploadThing uploads or media records.
- Map the existing UploadThing key through the public resolver route.
- Keep browser `width`/`height` layout props but omit height from Shutter URLs.
- Use ordinary Ernesta deployment configuration to select Bunny or Shutter
  without a data migration. Do not add traffic-splitting or cutover automation
  to Shutter.
- Compare dimensions, visual quality, bytes, first render, cache behavior, and
  source failures on representative production-like images.
- Leave the timing of the manual switch and removal of Bunny to the operator.

Exit criteria: public cache hits avoid imgproxy, Unpic emits only canonical
variants, and Ernesta can switch back to Bunny through configuration.

### 7. Migrate Pane View private still images

- Add a local adapter that issues `image_source` capabilities only after Pane
  View authorization and refreshes them before their 24-hour expiry.
- Keep Pane's SHA-256 Source IDs while using current Railway presigned locators;
  a later original-storage move to R2 changes only locator creation.
- Preserve layout behavior while removing height/aspect-ratio transforms from
  the image URL.
- Validate `no-store` browser responses, authorization on every Worker request,
  cache reuse across capability renewal, and fail-closed quota behavior.
- Keep the provider selectable through Pane View deployment configuration until
  the operator performs the manual switch.

Exit criteria: unauthorized, expired, tampered, and wrong-purpose capabilities
never reach cache bytes; valid renewed capabilities reuse canonical renditions.

### 8. Migrate Pane View video posters

- Submit `preview_job` video capabilities through the canonical idempotent URL.
- Poll using the shared job adapter and construct public or authorized private
  master delivery URLs from ready descriptors.
- Compare the one-second/fallback frame, dimensions, WebP quality, latency, and
  failure mapping with Pane View's current video derivative path.
- Keep video provider selection independent for the operator-managed switch.

Exit criteria: production-like video jobs recover from missed dispatch and
transient failure, and Pane View never treats the job ledger as media truth.

### 9. Migrate Pane View PDF previews

- Repeat the video integration for `pdf` with the separate PDF Executor.
- Compare first-page rendering, dimensions, quality, corrupt input, and
  password-protected failure behavior with the current implementation.
- Keep PDF provider selection independent for the operator-managed switch.

Exit criteria: the PDF path meets the same idempotency, recovery, polling,
delivery, and purge guarantees without sharing video execution authority.

### 10. Hand off for operator-managed cutover

- Document the observable signals available to the operator: Worker request/CPU
  budget, edge and R2 hit rates, imgproxy render rate, origin errors, job latency,
  retry exhaustion, purge failures, and R2 growth.
- Provide the deployment configuration needed to select Bunny/Shutter and the
  old/new Pane paths independently.
- Do not implement traffic splitting, a timed observation gate, automatic
  rollback, provider retirement, or a cutover controller in Shutter.
- The operator personally decides when to switch traffic, how long to observe,
  whether to roll back, and when to remove Bunny, the replaced Pane optimizer,
  or obsolete `cdn-selector` routes.
- Surface the documented Workers Paid threshold; upgrading the account remains
  an operator action.

Exit criteria: the operator has verified configuration switches and an
observability checklist. Performing the production cutover is outside the code
implementation plan.

## Cross-cutting verification

- Space and purpose confusion fails closed across every route.
- Capability renewal and key rotation do not fragment canonical cache identity.
- Public and private cache namespaces cannot collide.
- Source Purge removes edge, R2, and job state and is safe to retry after partial
  completion.
- Changed source bytes use a new Source ID; changing storage locator does not.
- Source Locators, capability contents, stack traces, and executor stderr never
  appear in public responses or unredacted logs.
- No migration changes application upload ownership or introduces a Shutter
  media catalog.

## Deferred beyond v1

- Upload handling or direct-upload grants.
- Asset/source catalog and tenant CRUD.
- Webhook completion.
- Arbitrary transforms, crop, AVIF negotiation, timestamps, or PDF page choice.
- Automatic idle/LRU cache budgets.
- Published npm SDK.
