# Separate cache eviction from Derivative retention

Optimized image Renditions are disposable cache entries deleted 30 days after
creation by R2 lifecycle policy, while video posters and PDF covers remain in
the Rendition Store until the consuming application explicitly purges their
immutable source identity. V1 has no idle/LRU tracking or storage budgets. A
Source Purge removes all cached variants, stored Derivatives, and Rendition Jobs
for that source. Capability expiry only ends access and does not serve as a
storage-lifecycle signal.
