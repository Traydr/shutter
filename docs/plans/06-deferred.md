# Plan 06 — Deferred operations

Not scheduled. These items are not required for the registry, admin surface, or
first Source Delivery release.

## Operator accounts

Replace the single bootstrap credential when deployments need several operators
or per-Space access. This also pairs with a separate admin hostname.

## Encryption-key rotation tooling

Add a transactional command that unseals all capability keys with the old
`SHUTTER_ENCRYPTION_KEY` and reseals them with the new key. Until then, follow
the maintenance runbook.

## Shared Edge configuration storage

Do not add KV or a Durable Object by default. First measure Control snapshot
traffic after the per-isolate cache ships. Consider shared storage only if that
traffic is a real load problem and the security and consistency trade-off is
acceptable.

## Wider content delivery

Source Delivery initially allows images, videos, and PDFs. A later protocol can
add more content types only after it defines browser safety, cache behavior,
and content-disposition rules.
