# Encrypt private and non-public Source Capabilities

Consuming applications issue opaque Source Capabilities using authenticated
encryption rather than readable signed payloads. A capability carries immutable
Source ID, an allowlisted HTTPS Source Locator, purpose, and expiry; Shutter
alone can read or validate it, and visible key identifiers permit overlapping
rotation. Public sources with a trusted derivable Source Resolver need no
capability. This prevents browser clients from extracting private origin
credentials or modifying source claims while preserving stateless validation.
