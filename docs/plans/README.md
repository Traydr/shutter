# Shutter plans

This directory is the implementation history and execution queue. Plans
0003–0005 are complete. Cloudflare R2 bucket `shutter-renditions` is confirmed
as the single Rendition Store: Railway services use its S3-compatible
credentials and Edge reads the same bucket through its native binding.

The authoritative domain vocabulary is in `CONTEXT.md`. Plan 0001 is the
foundation roadmap and plan 0002 records current v1 progress.

## Execution order

| Plan | Purpose | Priority | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| [0001 — Foundation](./0001-shutter-foundation.md) | Deliver focused image, video-poster, and PDF-preview infrastructure and migrate the public application then the private application. | — | — | — | ACTIVE ROADMAP |
| [0002 — V1 completion](./0002-shutter-v1-completion.md) | Record the agreed completion order and milestone status. | — | — | 0001 | ACTIVE TRACKER |
| [0003 — Complete master delivery](./0003-complete-master-delivery.md) | Reconcile the Rendition Store and implement first-request public/private master delivery. | P1 | L | — | DONE |
| [0004 — Source Purge](./0004-implement-source-purge.md) | Implement authenticated, idempotent cleanup across jobs, objects, and cache tags. | P1 | L | 0003 | DONE |
| [0005 — Observability and verification](./0005-observability-and-production-verification.md) | Add redacted events, end-to-end checks, and the operator runbook. | P2 | M | 0003, 0004 | DONE |

Status values for executable plans: `TODO`, `IN PROGRESS`, `DONE`,
`BLOCKED (<reason>)`, or `REJECTED (<reason>)`.

## Dependency notes

- Plan 0003 establishes one canonical storage topology and the code path for
  reading Master Previews. Plan 0004 must delete from that same store.
- Plan 0005 verifies completed delivery and purge behavior, so it follows both
  functional plans.
- After plan 0005, continue with private application still-image integration,
  video posters, and PDF previews as phases 7–9 of plan 0001. Consumer
  repositories are outside this workspace; obtain their paths and explicit
  write authorization before changing them.

Production configuration was re-audited on 2026-07-12. Control has the Space
capability/API registries and the least-privilege Cloudflare purge credential;
the Worker has its three required secrets and native R2 binding. Applying
Railway IaC remains an operator-reviewed action.

## Already implemented

- Protocol, capability crypto, normalization, cache identity, Space policies,
  and Node/workerd conformance fixtures.
- Public UploadThing resolver, public located-source, private source, and
  private master route shells. Private capability validation occurs before
  cache access.
- Durable job submission, polling, claims, heartbeats, completion, retries,
  one-job executor wakes, and the five-minute recovery sweep.
- Video and PDF processors and Railway serverless executor configuration.
- The public application's Shutter/Unpic integration and the custom Worker domain.

## Operating boundaries

- Do not print or commit capability keys, API tokens, object-store credentials,
  or presigned URLs.
- Do not run `railway config apply`, `wrangler deploy`, push, or open a PR
  without explicit operator instruction. A plan-only `railway config plan` is
  required after Railway IaC changes.
- Keep uploads, source storage, media records, and end-user authorization in
  consuming applications. Shutter owns only generated Renditions and its job
  ledger.
- The acceptance gate is `pnpm check`. Edge tests use workerd and may require a
  local port outside a restricted sandbox.

## Findings considered and rejected

- Adding a cache-hit-only public master route: rejected because it would return
  bytes only after an out-of-band optimized variant already existed and would
  fail the first-request contract.
- Making Master Previews public to give imgproxy a source URL: rejected because
  private Master Previews must remain behind capability authorization.
- Moving Source Objects into Shutter storage: rejected by ADR-0001 and ADR-0007.
