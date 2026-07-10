---
status: superseded by ADR-0007
---

# Own the media catalog and durable jobs

Shutter owns the catalog of Shutter Assets, Renditions, and durable processing
jobs. Applications reference a Shutter Asset while retaining their own Source
Object reference and all business metadata. This prevents every consuming
application from reimplementing retries, execution leases, rendition status,
and delivery policy.
