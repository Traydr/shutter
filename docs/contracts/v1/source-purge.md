# V1 Source Purge

## Request

```http
POST /v1/spaces/{spaceId}/sources/{sourceId}/purge
```

The Space API credential authenticates the request and must match `spaceId`.
The application must first make the Source Object unavailable, stop issuing new
Source Capabilities, and stop submitting Rendition Jobs for the Source ID.

Source Purge is cleanup, not capability revocation. It provides no guarantee
that a capability can no longer fetch a Source Object that remains available.

## Completion

Shutter serializes job submission, completion, and purge for the source, then:

1. Invalidates and removes its Rendition Jobs.
2. Deletes every object beneath its per-source R2 cache and master prefixes.
3. Globally purges its hashed Cloudflare source cache tag.

`204 No Content` means all three steps completed. Missing jobs or objects still
produce `204`, making the operation idempotent. Any partial failure returns a
retryable service error and the caller repeats the same request.

R2 deletion occurs before Cloudflare tag purge. An Executor that loses its
processing-token comparison after uploading deletes **this attempt's** stale
output only, conditioned on the object ETag from its own upload, so a newer
winning Master Preview at the same deterministic key is left intact. Ambiguous
complete failures (lost responses or non-CAS Control errors) must not delete
the object until Control accepts a fail transition for that processing token.
