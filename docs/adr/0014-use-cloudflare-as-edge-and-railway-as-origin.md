# Use Cloudflare as the delivery edge and Railway as the origin

Cloudflare owns Shutter's delivery edge: a Worker authorizes private Source
Capabilities before every local edge-cache lookup, while the ordinary CDN
caches canonical public Renditions. Railway hosts Shutter Control, imgproxy,
Executors, and job persistence; Cloudflare R2 is the central Rendition Store.
Railway CDN caching is excluded from private origin paths. This provides the
programmable authorization and post-decryption cache keys that Railway's
currently documented edge products do not, while keeping execution services on
Railway and Rendition bytes adjacent to the Cloudflare edge.
