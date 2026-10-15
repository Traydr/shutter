# Keep Workers Caching off the delivery Worker

Cloudflare's Workers Caching (July 2026, every plan including Workers Free) puts
a tiered cache in front of a Worker: a hit is answered without running the
Worker and bills no CPU, though it still counts as a request. Shutter does not
enable it on `shutter-edge`. The Worker keeps answering every delivery request
itself, from the data-center-local Cache API and then R2, and public responses'
`s-maxage` governs only caches downstream of it. A Worker on a custom domain
runs in front of the zone cache, so no Cloudflare cache has been holding those
public responses; "ordinary CDN caching" in the earlier ADRs means this
Worker-managed caching.

The switch is per entrypoint, not per route, and eyeball traffic on the custom
domain always enters the default entrypoint. Enabling it therefore also covers
the private routes and Source Delivery:

- Every private response (`private, no-store`) bypasses the cache, but only
  after a lookup in both tiers, which Cloudflare's own guidance says not to pay
  for on routes that are never cached.
- Workers Caching strips `Range` before the Worker runs and slices a cached
  full `200` instead. For a response it may not store, the Worker would send
  the whole object on every seek: every private object, which bypasses the
  cache, and every object above the cacheable size, which at launch is the
  Free plan limit on every plan, fetched from the origin each time. That undoes
  ADR 0023, and the local runtime does not emulate Workers Caching, so none of
  it can be tested before a deploy.
- `GET` and `HEAD` share an entry, so a cached optimization would answer `HEAD`
  with `200` where the v2 contract says `405`.

The way to scope it, a gateway entrypoint that calls a cached entrypoint
through `ctx.exports`, bills both invocations as requests: on Workers Free that
halves the daily allowance and still runs the gateway on every request, which
removes the reason to cache.

Public hits would also stop consulting the configuration snapshot. With a
30-day `s-maxage`, a decommissioned Space, or one moved to private, would keep
serving its public URLs until purged, and Control has no Space-wide purge: tags
name one source.

On Workers Free the gain is latency, request collapsing, and a higher tiered
hit ratio, not cost, because CPU is not billed and hits still count against the
daily request limit. That does not outweigh the above.

## Consequences

Workers Caching and the Cache API are separate stores. `ctx.cache.purge()`
clears only the former, and the runtime provides `ctx.cache` only to a Worker
deployed with `cache.enabled`. Source Purge therefore clears the Cache API with
the zone purge by tag, which removes tagged Cache API entries in every data
center; `cache.delete()` would clear only the data center it runs in. The Edge
purge route stays, answers `204` while the Worker has no cache of its own, and
purges by tag once one exists.

Revisit this with public optimization on its own Worker and hostname, which
gets its own default entrypoint and cache, together with: a Space-wide cache tag
that Control purges when a Space is decommissioned or changes route class,
origins, or resolvers; an accepted answer for `HEAD`; capability-free cache
keys for the located route, whose capability splits the key; and a preview
deployment that confirms the range and bypass behaviour.
