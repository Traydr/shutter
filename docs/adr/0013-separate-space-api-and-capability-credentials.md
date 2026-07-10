# Separate Space API and capability credentials

Each Shutter Space uses one server-only API credential for job, purge, and
administrative calls and a separate authenticated-encryption key for
application-issued Source Capabilities. Both carry key identifiers and support
overlapping rotation; browsers receive only opaque encrypted capabilities, and
source fetches remain constrained to the Space's HTTPS origin allowlist.
Separating the authorities limits the impact and rotation scope of either
credential leaking.
