# V1 Source Delivery

## Routes

```text
GET|HEAD /v1/public/{space}/delivery/resolver/{resolver}/{sourceRef}
GET|HEAD /v1/public/{space}/delivery/located/{sourceId}/{capability}
GET|HEAD /v1/private/{space}/delivery/{capability}
```

Source Delivery returns unchanged Source Object bytes. It accepts only `GET` and
`HEAD`. Other methods return `405 Method Not Allowed` with `Allow: GET, HEAD`.
Every query parameter is invalid, including Image Optimization parameters.

The resolver route derives a Source Locator from trusted Space policy. The
located and private routes accept only a `source_delivery` capability with an
allowlisted HTTPS locator. The public located Source ID must equal the
capability claim. Private delivery validates the capability before every cache
lookup. A Source Capability never enters cache identity.

## Media and headers

V1 allows these response content types:

- `image/avif`, `image/gif`, `image/jpeg`, `image/png`, and `image/webp`.
- `video/mp4`, `video/quicktime`, and `video/webm`.
- `application/pdf`.

HTML, scripts, SVG, archives, and other active or unknown content return
`415 Unsupported Media Type`. The response uses the canonical allowlisted
content type, `Content-Disposition: inline`, and
`X-Content-Type-Options: nosniff`. Shutter can also return bounded, validated
values for `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`, and
`Last-Modified`. It drops all other origin headers.

Shutter forwards one valid byte range and the `If-Range`, `If-None-Match`, and
`If-Modified-Since` conditions to the trusted origin. It preserves valid `206`,
`304`, and `416` responses. It rejects multiple or malformed ranges. Redirects,
encoded response bodies, malformed partial responses, and other origin statuses
fail closed.

## Cache behavior

One canonical Cache API key contains the route class, Space ID, and a fingerprint
of the Source ID. It never contains the locator, capability, request path, or
range. A complete `200` response with a valid `Content-Length` of at most 512 MB
can populate this entry. Cloudflare can answer later range and conditional
requests from the complete entry.

A cold `206` response and a complete object above 512 MB stream from the origin
without entering the cache. A valid cold `206` whose total size fits the cache
bound warms the complete object in the background so later ranges hit the edge.
Cold partial and `416` responses carry `private, no-store` so downstream caches
never store them. Source Delivery never writes an original to the R2
Derivative Store. Source Purge removes the canonical entry with the shared hashed
Source tag.

Private browser responses use `Cache-Control: private, no-store` and do not
expose the cache tag. Public responses use the standard one-day browser and
30-day edge cache policy.
