# V1 operational guardrails

## Cloudflare launch plan

- Workers plan: Free initially.
- Worker fail mode: closed for every capability-bearing route.
- Free-plan daily request ceiling: 100,000 requests per UTC day.
- Warning threshold: 70,000 requests in one UTC day.
- Critical and paid-upgrade threshold: 90,000 requests in one UTC day or normal
  traffic trending toward the daily ceiling.
- Free-plan CPU validation: the implementation spike must keep capability
  validation and cache-hit handling within the 10 ms CPU allowance.

Shutter never fails open, skips capability validation, or weakens private cache
behavior to avoid a plan limit.

## Initial rate-limit rule

- Scope: delivery-host paths under `/v1/`.
- Characteristic: client IP.
- Initial rate: 300 requests per 10 seconds.
- Cached requests count, because private and public located-source hits invoke
  the Worker even when rendition bytes are cached.
- Mitigation: block for the supported 10-second Free-plan window.

The threshold is validated against representative Ernesta pages and large Pane
View galleries before production cutover. Cloudflare rate counters are not a
global exact budget: they are data-center scoped and enforcement may lag. The
rule is an abuse and cost guard, not part of authorization correctness.

## Cutover ownership

Production cutover is performed manually by the operator. Shutter implements no
traffic splitter, timed observation gate, automatic rollback, provider-retirement
workflow, or cutover controller. Consumer deployment configuration may keep old
and new providers selectable, while the operator owns switch timing, observation,
rollback, and final cleanup.

## Control logging

- Every Control operational event is emitted as structured JSON to stdout.
- When its OTLP endpoint is configured, Control also exports the same allowlisted
  event to the Parseable `shutter-logs` dataset. Export failure never blocks request
  processing or weakens authorization behavior.
- Every non-health Control request returns a server-generated `X-Request-Id` and
  emits one `control.http.completed` event containing only that ID, method,
  matched route template, status, duration, and outcome.
- `/healthz` is excluded from request logs.
- Capabilities, locators, presigned URLs, credentials, headers, cookies, bodies,
  query strings, raw paths, raw Source IDs, command lines, stderr, error messages,
  and stacks are forbidden from structured events.
- Parseable retains the `shutter-logs` dataset for 30 days. Its Control credential has
  dataset-scoped ingestion authority only.
- Railway stdout is the fallback because direct OTLP batching is memory-only and
  a forced process kill can lose the final batch.
