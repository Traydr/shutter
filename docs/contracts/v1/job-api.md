# V1 Rendition Job API

## Canonical resource

```http
PUT /v1/spaces/{spaceId}/sources/{sourceId}/previews/{kind}
GET /v1/spaces/{spaceId}/sources/{sourceId}/previews/{kind}
```

`kind` is exactly `video` or `pdf`. The authenticated Space must match
`spaceId`. The tuple `(space_id, source_id, kind)` is the job's natural unique
key; clients do not supply a job ID or separate idempotency key.

Job API requests authenticate with the Space API credential in an
`Authorization: Bearer <token>` header. That credential is separate from Source
Capability keys and must belong to the `spaceId` in the route.

Submission requires a `preview_job` Source Capability whose Space, Source ID,
and kind exactly match the route. Image and master-preview capabilities are
rejected. The `PUT` body is strict JSON and contains no other fields:

```json
{
  "sourceCapability": "v1.<kid>.<iv>.<ciphertext-and-tag>"
}
```

## Submission behavior

- A first valid `PUT` creates the job and returns its current representation.
- A repeated `PUT` returns the existing pending, processing, or ready job.
- A `PUT` with a fresh Source Capability reactivates a `source_expired` job and
  starts a new bounded retry window on that same logical record.
- A new valid `PUT` reactivates `attempts_exhausted` and starts another bounded
  execution cycle on the same logical record.
- Deterministic source failures do not restart in place. Changed source bytes
  require a new Source ID; deleting and recreating an unchanged job requires
  Source Purge first.
- Concurrent identical submissions converge on the natural unique key and must
  not create multiple Master Previews.

The application polls the canonical `GET` resource. Webhooks are outside v1.

## HTTP semantics

- A valid `PUT` or `GET` for `pending` or `processing` returns `202 Accepted`.
- Every `202` includes `Location` with the canonical job URL and `Retry-After`.
- A `ready` or persisted `failed` representation returns `200 OK`; failure is
  job state rather than failure to read the resource.
- Authentication, capability, route, and request validation errors return an
  appropriate `4xx` response and do not create or mutate a job.
- Temporary Control or Postgres failures return `5xx`. The application retries
  the same idempotent canonical URL.

The JSON `status` is authoritative. Clients must not infer job failure merely
from a completed `200` response.

## Ready representation

```json
{
  "status": "ready",
  "master": {
    "sourceId": "application-issued-source-id",
    "kind": "video",
    "width": 1920,
    "height": 1080,
    "format": "webp"
  }
}
```

`width` and `height` are the actual Master Preview dimensions. The descriptor is
durable and contains no delivery URL, Source Locator, or Source Capability.
Shutter Control does not authorize end users or mint delivery capabilities.

For a public Space, the consuming adapter constructs the canonical public
master URL from this descriptor. For a private Space, the application first
authorizes its end user, issues a `master_preview` capability for the descriptor,
and constructs the canonical private master URL.

## Failed representation

```json
{
  "status": "failed",
  "failure": {
    "code": "source_expired",
    "action": "renew_capability"
  }
}
```

Failure codes and their required actions are stable v1 protocol values:

| Code | Action |
| --- | --- |
| `source_expired` | `renew_capability` |
| `attempts_exhausted` | `retry` |
| `source_missing` | `replace_source` |
| `unsupported_media` | `replace_source` |
| `source_too_large` | `replace_source` |
| `source_corrupt` | `replace_source` |
| `pdf_password_protected` | `replace_source` |
| `configuration_error` | `contact_operator` |
| `internal_invariant` | `contact_operator` |

The response contains no raw source locator, upstream response, stack trace,
Executor command line, or stderr. Those details exist only in access-controlled,
redacted operational logs. An invalid capability or request rejected before job
creation is an HTTP request error, not a persisted failed job.

## Executor Control wire API

Authenticated Executor role credentials call kind-scoped internal routes. Request
and response bodies are validated by `@shutter/protocol` parsers shared with
Executors.

### Claim response (`POST /internal/v1/executors/{kind}/claim`)

`204` when idle. Otherwise JSON:

```json
{
  "spaceId": "pane-view",
  "sourceId": "application-issued-source-id",
  "kind": "video",
  "locator": "https://t3.storageapi.dev/balanced-wrap-ocyiwwexhao/originals/a.mp4",
  "outputKey": "masters/v1/pane-view/<fingerprint>/video.webp",
  "processingToken": "opaque-token",
  "executionCycle": 0,
  "attemptNumber": 1
}
```

### Heartbeat / complete / fail

- Heartbeat body: `{ "processingToken": "..." }`
- Complete body: `{ "processingToken", "masterKey", "width", "height", "format": "webp", "objectEtag" }`
- Fail body: `{ "processingToken", "retryable", "code"? }` where `code` is a
  known job failure code when present

Stale processing tokens return `409` with `stale_attempt`.
