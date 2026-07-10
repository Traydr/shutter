# Encrypt private and non-public Source Capabilities

Consuming applications issue opaque Source Capabilities using authenticated
encryption rather than readable signed payloads. A capability carries immutable
Source ID, one strict purpose, and expiry. Only `image_source` and `preview_job`
carry an allowlisted HTTPS Source Locator; `master_preview` identifies an
existing stored kind without an original locator. Shutter alone can read or
validate the claims, and visible key identifiers permit overlapping rotation.
Public sources with a trusted derivable Source Resolver need no capability.
Routes reject a capability issued for any other purpose. This prevents browser
clients from extracting private origin credentials or modifying source claims
while preserving stateless validation.
