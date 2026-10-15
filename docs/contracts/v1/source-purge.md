# V1 Source Purge

## Request

```http
POST /v1/spaces/{spaceId}/sources/{sourceId}/purge
```

The Space API credential authenticates the request and must match `spaceId`.
The application must first make the Source Object unavailable, stop issuing new
Source Capabilities, and stop submitting Preview Jobs for the Source ID.

Source Purge is cleanup, not capability revocation. It provides no guarantee
that a capability can no longer fetch a Source Object that remains available.

## Completion

Shutter serializes job submission, completion, and purge for the source, then:

1. Invalidates and removes its Preview Jobs.
2. Deletes every object beneath its per-source R2 cache and master prefixes.
3. Asks the Edge to purge the hashed source cache tag from the Worker's own
   Workers Cache. The Edge does not enable Workers Caching (ADR 0031), so it
   has none and answers `204` at once; the call keeps the step correct if it
   ever does.
4. Globally purges the same hashed tag from the Cloudflare zone cache. The
   Edge's Cache API entries live there, cached Source Delivery bytes and
   optimized images alike, so this is the step that removes them, in every
   data center.

`204 No Content` means all four steps completed. Missing jobs or objects still
produce `204`, making the operation idempotent. Any partial failure returns a
retryable service error and the caller repeats the same request.

R2 deletion occurs before the tag purges. The Edge stores each Cache API entry
under a synthetic `https://cache.shutter.invalid/...` key with the source's
`Cache-Tag`, so a purge by URL cannot name it but a zone purge by tag removes it
everywhere. Neither `ctx.cache.purge()`, which reaches only Workers Caching, nor
`cache.delete()`, which reaches only the data center it runs in, can replace the
zone purge. Control calls the Edge `POST /internal/v1/cache/purge` endpoint with
the shared origin credential. An
Executor that loses its processing-token comparison after uploading deletes
**this attempt's** stale output only, conditioned on the object ETag from its
own upload, so a newer winning Master Preview at the same deterministic key is
left intact. Ambiguous complete failures (lost responses or non-CAS Control
errors) must not delete the object until Control accepts a fail transition for
that processing token.
