# V2 Source Purge

```http
POST /v2/spaces/{spaceId}/sources/{sourceId}/purge
```

The Space API credential authenticates the request and must match `spaceId`.
`sourceId` is one percent-encoded path segment holding a Source ID; for a
resolver source that is `{resolver}/{reference}`.

The operation is the v1 Source Purge with a v2 error format: it serializes with
job submission and completion for the source, removes the source's Preview Jobs,
deletes every object under its cache and master prefixes, purges the hashed
source tag from the Worker Cache API and the zone, and returns `204 No Content`
only when all four steps completed. Missing jobs or objects still produce `204`.
A partial failure returns a retryable problem and the caller repeats the same
request.

Purging a resolver source does not touch the application's object or the
resolver. A still-reachable object is re-fetched on the next request; the
application removes or replaces the object first when that is not wanted.
