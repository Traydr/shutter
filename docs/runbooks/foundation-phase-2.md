# Foundation Phase 2 deployment spike

This runbook applies only after an operator has reviewed the account, project,
domain, allowlist, and secret values. Repository checks exercise the same
authorization and cache ordering locally; this checklist captures the live
provider evidence required to close Phase 2.

## Cloudflare

1. Create the private `shutter-renditions` R2 bucket.
2. Apply `infra/cloudflare/r2-lifecycle.json` with:

   ```sh
   pnpm --filter @shutter/edge exec wrangler r2 bucket lifecycle set shutter-renditions --file ../../infra/cloudflare/r2-lifecycle.json
   ```

3. List the lifecycle rules and confirm the only object-expiration prefix is
   `cache/`, with an age of 2,592,000 seconds. No `masters/` rule may exist.
4. Set Worker secrets `CAPABILITY_KEYS`, `ORIGIN_BASE_URL`, and
   `ORIGIN_AUTH_TOKEN`. `CAPABILITY_KEYS` is JSON shaped as
   `{ "space-id": { "kid": "unpadded-base64url-32-byte-key" } }` and may
   contain overlapping verification keys.
5. Deploy the Worker. The configuration intentionally has no `nodejs_compat`.
6. Create a rate-limiting rule for `/v1/`, keyed by client IP, at 300 requests
   per 10 seconds with a 10-second block.

## Railway

1. Confirm the reviewed imgproxy and Space allowlists remain limited to Ernesta
   UploadThing projects `8w0z32yftd` and `rrsku8h9ue`, plus Pane View origins
   `https://t3.storageapi.dev` and `https://pane-view.traydr.dev`.
2. Preview `.railway/railway.ts` with `railway config plan`. Review every
   resource and variable change.
3. Apply only through the ordinary reviewed Railway workflow. Generate strong,
   independent `ORIGIN_AUTH_TOKEN`, `IMGPROXY_SECRET`, `IMGPROXY_KEY`, and
   `IMGPROXY_SALT` values directly in Railway after the services are created.
   Railway rejects `preserve()` during new-service creation, so add preservation
   to IaC only after that first apply. Give Control the same imgproxy values.
   The imgproxy key and salt are hex encoded.
4. Give Control a public HTTPS origin and put that exact URL in the Worker's
   `ORIGIN_BASE_URL`. Keep imgproxy private-only.

## Live evidence

- Direct requests to `/internal/v1/spike/rendition` without the Worker origin
  bearer return `401` and no bytes. imgproxy does the same without its separate
  bearer and rejects unsigned paths.
- A private master request with a tampered, expired, wrong-Space, or
  wrong-purpose capability returns no rendition bytes, including when its
  canonical Cache API and R2 entries exist.
- A valid private request reports `r2-hit` after Cache API eviction and
  `edge-hit` on the following request, while the browser response remains
  `Cache-Control: private, no-store`.
- A public located-source R2 or edge hit succeeds independently of capability
  renewal. A miss requires a valid, allowlisted `image_source` capability.
- Responses carry the protocol cache tag internally. Purging that tag removes
  matching edge entries globally; deleting both `cache/` and `masters/` Source
  prefixes prevents R2 repopulation.
- Workers analytics show AES-GCM plus the private cache-hit path below 10 ms CPU
  on representative gallery traffic.
- A 301-request burst inside 10 seconds triggers the configured rate-limit rule,
  while representative Ernesta and Pane View gallery loads stay below it.

Record account IDs, deployment URLs, secret values, and Source Locators only in
the provider secret stores or the private operational record—not in this repo.

## Recorded non-sensitive evidence

### 2026-07-11

- The active zone rate-limit rule matches URI paths beginning `/v1/`, uses the
  client IP characteristic, allows 300 requests per 10 seconds, and blocks for
  10 seconds. A same-location burst returned 300 Worker responses followed by
  one `429`; ten immediate follow-up requests also returned `429`.
- A synthetic public located-source object returned `r2-hit`, then `edge-hit`
  under a different capability string. Both responses had identical bytes,
  `Cache-Control: public, max-age=86400, s-maxage=2592000`, and the same hashed
  source cache tag. The edge hit also reported Cloudflare `HIT`.
- Purging that cache tag forced the next request back to `r2-hit`.
- Deleting the synthetic R2 object before purging its tag prevented
  repopulation; the next invalid-capability request returned `403` with
  `Cache-Control: private, no-store` and no rendition bytes.
- Pending: valid private capability renewal/key-rotation evidence, a live
  Control-to-imgproxy source render, unsigned imgproxy rejection, and focused
  AES-GCM/private-cache-hit CPU measurements.
