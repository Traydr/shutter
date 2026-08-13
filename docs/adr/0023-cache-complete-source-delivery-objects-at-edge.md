# Cache complete Source Delivery objects at Edge

Source Delivery uses one Cloudflare Cache API entry for a complete Source
Object. The key contains the route class, Space ID, and a fingerprint of the
immutable Source ID. It never contains the Source Locator or Source Capability.
Private requests validate their `source_delivery` capability before every cache
lookup.

Cloudflare can answer a byte-range or conditional request from a cached complete
response. A cold range goes directly to the trusted origin and remains a `206`
response. Shutter does not store that partial response because the Cache API
rejects `206` writes. Because media clients open with a `Range` header, a valid
cold `206` whose `Content-Range` total fits the object limit also triggers a
background fetch of the complete object, which warms the one cache entry so the
following seeks hit the edge. `If-Range` is evaluated at the Edge against the
cached validators, so resumable clients hit the cache too. A complete `200`
response can enter the cache only when it has a valid `Content-Length` no
larger than the Cache API's 512 MB object limit. Larger objects still stream
from the origin. Source Purge clears the entry with the same Source tag that
clears Renditions and Master Previews.

Source Delivery never writes original bytes to R2. R2 remains the Rendition
Store for Image Optimizations and Master Previews. This keeps application-owned
storage authoritative while allowing warm video seeks at the edge.

The focused state-model prototype is preserved on the
[`prototype/source-delivery-range-cache`](https://github.com/Traydr/shutter/tree/prototype/source-delivery-range-cache)
branch. The decision also follows Cloudflare's documented
[Cache API behavior](https://developers.cloudflare.com/workers/runtime-apis/cache/):
cached complete responses with `Content-Length` can answer ranges and `206`
responses cannot be stored. Cloudflare documents a
[512 MB Cache API object limit](https://developers.cloudflare.com/workers/platform/limits/#cache-api-limits).
