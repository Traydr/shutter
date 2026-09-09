# V2 Preview Job API

## Canonical resource

```http
PUT /v2/spaces/{spaceId}/sources/{sourceId}/previews/{kind}
GET /v2/spaces/{spaceId}/sources/{sourceId}/previews/{kind}
```

`kind` is exactly `video` or `pdf`. `sourceId` is one percent-encoded path
segment holding a resolver Source ID, `{resolver}/{reference}`, for a resolver
the Space has. Requests authenticate with the Space API credential in
`Authorization: Bearer <token>`, which must belong to `spaceId`. There is no
Source Capability: the `PUT` body is `{}` and nothing else.

Everything else follows the v1 contract. `(space_id, source_id, kind)` is the
natural unique key; a repeated `PUT` returns the existing job; `202` carries
`Location` and `Retry-After`; `ready` and persisted `failed` representations
return `200` with the v1 body shapes and failure codes. A `PUT` whose
`sourceId` is not a resolver source, or names a resolver the Space does not
have, is rejected with `404` and creates nothing. `GET` and Source Purge check
only the `{resolver}/{reference}` shape, so a job stays readable, its persisted
failure included, after its resolver is removed.

## Source access

Control resolves the Source Locator when an Executor claims the job, not when
the application submits it: a template expands, an S3 resolver presigns for the
claim lease. A later attempt gets a fresh locator. The Executor wire is the v1
claim, heartbeat, complete, and fail contract, unchanged. The retry window is
the v1 23-hour budget; it is not extended by a refreshed locator.

A resolver removed while the job is open fails it with `configuration_error`
and the `contact_operator` action. `source_expired` cannot occur for a resolver
source.

## Errors

Request errors use the v2 problem format in [errors.md](./errors.md).
