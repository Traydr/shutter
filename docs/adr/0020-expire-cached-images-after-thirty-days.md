# Expire cached images after thirty days

R2 objects under each Space's `cache/` prefix expire 30 days after creation,
while Master Previews remain outside automatic lifecycle deletion and require a
Source Purge. V1 does not track last access or implement storage-budget/LRU
eviction; an expired optimized image is regenerated when next requested. This
uses R2's native lifecycle behavior and avoids adding an access ledger and
cleanup service for disposable bytes.
