# Separate Source ID from Source Locator

Every Shutter request carries an application-issued immutable Source ID for
cache, job, storage, idempotency, and purge identity separately from the current
Source Locator used to fetch bytes. Public providers may use trusted
Space-configured Source Resolvers; private Railway or R2 objects bind a presigned
HTTPS locator to the Source ID inside an encrypted Source Capability. Storage
migration therefore changes only source access and does not invalidate canonical
Rendition identity or require Shutter to hold source-bucket credentials.
