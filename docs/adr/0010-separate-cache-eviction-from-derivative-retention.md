# Separate cache eviction from Derivative retention

Optimized image Renditions are disposable cache entries evicted by a
Space-configured idle period or storage budget, while video posters and PDF
covers remain in the Rendition Store until the consuming application explicitly
purges their immutable source identity. A Source Purge removes all cached
variants, stored Derivatives, and Rendition Jobs for that source. Capability
expiry only ends access and does not serve as a storage-lifecycle signal.
