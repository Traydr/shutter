# Separate public and private Rendition paths

Public and private Spaces use distinct URL shapes. A public URL uses an
allowlisted Source Resolver when possible, or excludes an encrypted presigned
locator from Cloudflare's canonical cache key; a private URL always invokes the
Worker, which decrypts first and derives a non-public canonical key from the
Source ID. Shutter verifies that the route class matches trusted Space policy,
preserving private authorization while avoiding locator-driven fragmentation of
the global public cache.
