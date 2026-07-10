# V1 Rendition URLs

## Routes

```text
GET /v1/public/{space}/resolver/{resolver}/{sourceRef}?w={width}&q={quality}
GET /v1/private/{space}/source/{capability}?w={width}&q={quality}
GET /v1/private/{space}/master/{capability}?w={width}&q={quality}
```

`sourceRef` is one percent-encoded path segment interpreted only by the named,
Space-configured Source Resolver. It is never accepted as an arbitrary URL.

The private source route accepts only `image_source`. The private master route
accepts only `master_preview`; its kind is taken from the authenticated claims.
The route class must match the configured Space policy.

V1 also requires canonical public routes for capability-located originals and
stored Master Previews. A located-original capability is checked only before an
application-owned source fetch; it is excluded from public cache identity. A
public Master Preview is addressed by Source ID and kind without a capability.

## Parameters

`w` and `q` are the only accepted query parameters. Width is required by the
consumer adapter; quality may be omitted and uses the Space default. Values are
normalized by the V1 Rendition Policy. Malformed values and all unknown query
parameters return an uncacheable `400 Bad Request`.

For the public route, valid non-canonical or omitted values receive `308
Permanent Redirect` to the URL with explicit normalized `w` and `q`, in that
order. A conforming Unpic adapter emits canonical values directly and therefore
does not incur a redirect.

For private routes, the Worker validates the capability before cache access,
normalizes `w` and `q`, and derives an internal canonical cache key from Space,
Source ID, input kind, normalized width, and normalized quality. The expiring
capability is excluded from that key and the response is served without a
normalization redirect.
