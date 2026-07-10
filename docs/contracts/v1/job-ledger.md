# V1 Rendition Job ledger

Postgres has one application table: `rendition_jobs`. Drizzle migrations own its
schema. No Space, Source, Asset, attempt-history, purge, or delivery-token tables
exist in v1.

## Identity

The primary or equivalent unique key is:

```text
(space_id, source_id, kind)
```

`kind` is `video` or `pdf`. This tuple is also the API, idempotency, polling, and
Master Preview identity.

## Current-state fields

The row stores only what is required to execute and poll the current job:

- `space_id`, `source_id`, and `kind`.
- `status`: `pending`, `processing`, `ready`, or `failed`.
- Nullable opaque `source_capability` while work is active.
- `execution_cycle` and current `attempt_number`.
- `retry_deadline_at` and nullable `next_attempt_at`.
- Nullable `processing_token`, `lease_expires_at`, and `heartbeat_at`.
- Nullable ready metadata: deterministic master key, width, height, format, and
  object ETag.
- Nullable stable `failure_code`.
- Creation and last-update timestamps.

Exact SQL types belong to the migration, but timestamps are timezone-aware and
counters are non-negative. State-specific database checks should reject
impossible combinations where practical.

## Data minimization and history

The opaque Source Capability is cleared on `ready` and every terminal `failed`
transition. Reactivation requires a new valid capability. Source Purge deletes
the entire row.

There is no persisted attempt history. Structured internal logs carry Space,
Source ID hash, kind, execution cycle, attempt number, and processing token for
correlation without logging Source Locators or capability contents.
