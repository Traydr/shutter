# Separate Space API and capability credentials

Each Shutter Space uses one server-only API credential for job and purge calls
and a separate authenticated-encryption key for
application-issued Source Capabilities. Both carry key identifiers and support
overlapping rotation; browsers receive only opaque encrypted capabilities, and
source fetches remain constrained to the Space's HTTPS origin allowlist.
Separating the authorities limits the impact and rotation scope of either
credential leaking.

Capability-decryption keys are installed only in the Cloudflare Worker and
Shutter Control. Executors use kind-specific role credentials and receive a
validated Source Locator only in an individual claim response. A compromised
Executor can therefore expose a source assigned to that process, but cannot
decrypt arbitrary capabilities or mint new ones.
