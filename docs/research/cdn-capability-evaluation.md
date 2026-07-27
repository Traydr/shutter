# CDN capability evaluation

Evaluated 2026-07-10 for Shutter's encrypted Source Capabilities, canonical
Rendition Cache keys, private per-request authorization, and public delivery.

## Required behavior

- Run authenticated decryption before any private cache lookup.
- Derive a stable cache key from Space, immutable source identity, and normalized
  rendition parameters rather than from the encrypted capability URL.
- Reuse cached bytes across capability renewal and key rotation.
- Purge all cached variants for one immutable source identity.
- Use ordinary globally cached delivery for public Spaces.

## Railway

Railway's documented edge network terminates TLS and routes requests to the
nearest deployment; it does not document user-supplied edge code, capability
validation, or custom cache-key derivation. Railway has described an opt-in CDN
that respects origin `Cache-Control` and uses surrogate keys, but a Railway
employee stated in late June 2026 that the one-click CDN was temporarily
unavailable while changes were being made.

Consequently, Railway is suitable as Shutter's origin runtime and private
service network, but its CDN cannot currently be a design
dependency for authorization-aware private caching. If the CDN returns, its
documented behavior should be re-evaluated with a spike before using it even for
public canonical rendition URLs.

The current Railway configuration declares the application service and
its custom domain but no Railway CDN resource or setting. Production image
delivery remains explicitly configured for Bunny.

Sources:

- [Railway edge networking](https://docs.railway.com/networking/edge-networking)
- [Railway CDN incident report](https://blog.railway.com/p/incident-report-march-30-2026-authenticated-user-data-cached)
- [Railway employee: one-click CDN currently unavailable](https://station.railway.com/questions/one-click-cdn-option-is-not-available-41ebf784)

## Cloudflare Free

Cache Rules alone cannot implement the private path. The Free plan can mark
responses eligible, set edge TTLs, and ignore or sort query strings, but detailed
query-string/header/host custom cache-key composition remains Enterprise-only.
Ignoring the encrypted capability in a conventional cache rule would be unsafe
because the cache could respond before authorization.

A Cloudflare Worker can implement the required gateway:

1. Decrypt and authenticate the Source Capability with Web Crypto AES-GCM.
2. Validate expiry, purpose, origin allowlist, and normalized parameters.
3. Build a synthetic canonical Request URL from the authenticated source
   identity and normalized transformation.
4. Use the Cache API with that Request as the cache key.
5. On a miss, fetch Shutter's Railway origin with a Worker-to-origin credential,
   then cache and return the rendition.

This works on a custom domain and keeps the capability out of the cache key.
Cache API entries are local to the Cloudflare data center that handled the
request and do not use Tiered Cache, so geographically distributed traffic can
produce one miss per active location. The central Shutter Rendition Store still
prevents those edge misses from necessarily invoking imgproxy again.

The Workers Free plan currently permits 100,000 requests per day, 10 ms CPU per
request, 128 MB memory, and 512 MB Cache API objects. Every private image request
invokes the Worker, including a cache hit. Exceeding the free request allowance
requires the paid Workers plan or causes failures; a private route must fail
closed rather than bypass the Worker.

Cloudflare Free also provides one path-based rate-limiting rule with a 10-second
counting period. Counters are scoped per data center and enforcement can lag, so
the rule reduces simple per-IP abuse but cannot enforce a precise global origin
or cost budget. Shutter starts at 300 requests per client IP per 10 seconds,
counts cached assets, and validates the threshold against real gallery loads.

Cloudflare makes cache purge by URL, prefix, hostname, and tag available on the
Free plan. Cache API custom keys have purge caveats, so Shutter should tag
renditions by a hashed Space/source identity and verify global tag purge in the
spike.

Sources:

- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Cloudflare Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [How Workers interact with cache](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare cache features by plan](https://developers.cloudflare.com/cache/plans/)
- [Cloudflare cache purge availability and limits](https://developers.cloudflare.com/cache/how-to/purge-cache/)
- [Cloudflare rate-limiting availability](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [Cloudflare request-rate calculation](https://developers.cloudflare.com/waf/rate-limiting-rules/request-rate/)

## Accepted topology

### Private Spaces

Every request passes through the Worker. The Worker decrypts and authorizes
before looking up its data-center-local canonical cache entry. Cache misses use
an authenticated origin request to Shutter on Railway. Railway CDN caching must
be disabled or bypassed for this path.

### Public Spaces

Public URLs put immutable source identity and normalized transformation in the
canonical path. Resolver-backed originals and public Master Previews use the
ordinary CDN. A public located-source route passes through the Worker so it can
derive a canonical Cache API key that excludes the encrypted presigned locator;
it consults cache and R2 before decrypting the capability for an original-source
miss. Renewed capabilities therefore reuse existing bytes without making a
private locator part of public cache identity. Shutter rejects any route whose
trusted Space policy is not public.

### Deployment boundary

- **Cloudflare Worker**: private capability gateway and cache, plus the public
  located-source canonical cache.
- **Cloudflare CDN**: public canonical rendition cache.
- **Railway**: Shutter Control, imgproxy, Executors, and job database.
- **Cloudflare R2**: central Rendition Store.

Accepted for an implementation spike on 2026-07-10. See ADR 0014.

## Required spike

- Measure AES-GCM validation plus normalization against the 10 ms Free CPU
  allowance.
- Verify private cache hits across renewed capabilities and rotated key IDs.
- Measure repeat misses across Cloudflare locations.
- Verify Cache-Tag purge removes every edge variant for a source.
- Verify the Railway origin rejects requests without the Worker credential.
- Confirm public canonical URLs use the ordinary CDN cache and private URLs
  always invoke the Worker.
