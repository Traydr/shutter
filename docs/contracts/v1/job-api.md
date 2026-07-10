# V1 Rendition Job API

## Canonical resource

```http
PUT /v1/spaces/{spaceId}/sources/{sourceId}/previews/{kind}
GET /v1/spaces/{spaceId}/sources/{sourceId}/previews/{kind}
```

`kind` is exactly `video` or `pdf`. The authenticated Space must match
`spaceId`. The tuple `(space_id, source_id, kind)` is the job's natural unique
key; clients do not supply a job ID or separate idempotency key.

Submission requires a `preview_job` Source Capability whose Space, Source ID,
and kind exactly match the route. Image and master-preview capabilities are
rejected.

## Submission behavior

- A first valid `PUT` creates the job and returns its current representation.
- A repeated `PUT` returns the existing pending, processing, or ready job.
- A `PUT` with a fresh Source Capability reactivates a `source_expired` job and
  starts a new bounded retry window on that same logical record.
- Other terminal outcomes do not restart in place. Changed source bytes require
  a new Source ID; deleting and recreating an unchanged job requires Source
  Purge first.
- Concurrent identical submissions converge on the natural unique key and must
  not create multiple Master Previews.

The application polls the canonical `GET` resource. Webhooks are outside v1.
