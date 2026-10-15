# Memoize the Edge snapshot by registry generation

This amends ADR 0021's "no policy cache in Control" for one read: the Edge
config snapshot. Control keeps the last snapshot it built, with the registry
generation it was read at, and answers each snapshot request with one
generation read. A matching generation returns the memo, with a fresh
`generatedAt`; any other generation, higher or lower, rebuilds it, and
requests that observed the same generation share the rebuild. A rebuild reads
after its requests observed the generation, so it is never older than what
they saw.

Freshness is unchanged because ADR 0021's reason for reading Postgres on every
request still holds: every replica still asks Postgres on every request, and a
committed change is visible to the next one with no invalidation protocol.
The generation is what makes the memo exact rather than approximate: every
registry write (`createSpace` and every Space-scoped mutation) bumps it in the
same transaction as the change, a migration that changes snapshot contents
bumps it too (0003 does), and the snapshot is a function of the rows that
write covers. The rule that keeps this true is operational as well as in code:
**an out-of-band SQL change to registry rows must bump
`space_registry_metadata.generation` in the same transaction**, or replicas
keep serving the memo until the next write.

Every snapshot poll from every isolate used to cost seven statements, a
policy parse per Space, and an AES-GCM unseal per active key; now a poll costs
one indexed single-row read. The per-request policy reads behind optimize,
resolve, and the Job API are not memoized: each is already one statement, so a
generation check would cost the same round trip and save only microseconds of
parsing.

## Consequences

- Decrypted Capability Keys stay in Control's heap for the life of the memo,
  where they were transient before. The Worker already holds the same keys.
- `control.registry.keys_excluded` fires once per rebuild instead of once per
  poll, so a persistently undecryptable key is reported when the generation
  moves, not every minute.
- A read inside a caller-owned transaction (the import) never uses the memo.
