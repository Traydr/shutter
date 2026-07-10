# Authorize before private cache lookups

Private Shutter Spaces validate an application-issued Source Capability before
every rendition-cache lookup, including cache hits. Cache objects use stable
keys derived from immutable source identity and normalized rendition parameters,
so cached bytes may outlive one capability and be reused after authorization is
refreshed without becoming publicly retrievable. Cache privacy is immutable
Space policy rather than a caller-controlled parameter; public Spaces may use
ordinary CDN caching.

Private browser responses additionally use `Cache-Control: private, no-store`.
Only the Worker's separately cloned canonical response receives the internal
cache TTL, preventing browser caching from bypassing the authorization gateway.
