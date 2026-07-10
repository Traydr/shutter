# Own generated Rendition storage

Shutter stores the generated and cached Rendition bytes it produces in its own
Rendition Store, while Source Objects remain in consuming-application storage.
Deterministic keys use Space, immutable source identity, rendition kind, and
normalized parameters; applications remain authoritative for the relationship
between media records and returned Rendition references. This avoids granting
Shutter write access to application buckets or renewing destination grants on
job retries without reintroducing a Shutter media catalog.
