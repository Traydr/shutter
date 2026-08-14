# V1 Derivative URLs

## Routes

```text
GET /v1/public/{space}/resolver/{resolver}/{sourceRef}?w={width}&q={quality}
GET /v1/public/{space}/located/{sourceId}/{capability}?w={width}&q={quality}
GET /v1/public/{space}/master/{kind}/{sourceId}?w={width}&q={quality}
GET /v1/private/{space}/source/{capability}?w={width}&q={quality}
GET /v1/private/{space}/master/{capability}?w={width}&q={quality}
```

`sourceRef` is one percent-encoded path segment interpreted only by the named,
Space-configured Source Resolver. It is never accepted as an arbitrary URL.

`sourceId` is likewise one percent-encoded path segment. On the public located
route it must equal the `image_source` claim. Edge cache and R2 are checked
before capability decryption; the capability is required and validated only
when Shutter must fetch the application-owned original. The capability is not
part of public cache identity. This is the deliberate public located-source
exception to the general rule that a route validates capability purpose before
cache access: an already-materialized public Derivative remains public after the
source-fetch capability expires.

The public master route accepts `kind` values `video` and `pdf` and requires no
capability. The private source route accepts only `image_source`. The private
master route accepts only `master_preview`; its kind is taken from authenticated
claims. Every route class must match configured Space policy.

## Parameters

`w` and `q` are the only accepted query parameters. Width is required; omitting
it returns an uncacheable `400 Bad Request`. Quality may be omitted and uses the
Space default. Values are normalized by the V1 Derivative Policy. Duplicate,
malformed, and unknown query parameters also return an uncacheable `400`.

For the public route, valid non-canonical values or an omitted quality receive
`308 Permanent Redirect` to the URL with explicit normalized `w` and `q`, in
that order. A conforming Unpic adapter emits canonical values directly and
therefore does not incur a redirect.

For private routes, the Worker validates the capability before cache access,
normalizes `w` and `q`, and derives an internal canonical cache key from Space,
Source ID, input kind, normalized width, and normalized quality. The expiring
capability is excluded from that key and the response is served without a
normalization redirect.

Private browser responses use `Cache-Control: private, no-store`. The Worker
may store a separately cloned response at its non-public canonical Cache API key
for 24 hours, but it must validate the request capability before every lookup
and must never forward the internal cache header to the browser.
