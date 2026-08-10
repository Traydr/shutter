# Plan 01 — Space registry schema

One PR. Add the database layer and shared policy schema. Do not change runtime
callers in this plan.

## Goal

Postgres can store every Shutter Space policy and credential. Tenant values
remain in the existing package until plan 02 performs the cutover.

## Not in scope

Runtime reads, tenant-data removal, Edge refresh, and the admin surface.

## Decisions

- Every table has an incrementing internal primary key.
- A Space also has an immutable, unique public identifier such as
  `example-public`.
- A Space's route class is immutable. To change from public to private, or from
  private to public, create a new Space with a new public identifier.
- A Space is decommissioned, not deleted. Its public identifier remains
  reserved, and old jobs and cache keys keep their meaning.
- Other policy fields can change.

## Steps

### 1. Move the policy schema into `@shutter/protocol`

Move the existing `SpacePolicy` parser and validation rules from
`packages/space-config` to `packages/protocol/src/`. Validate the discriminated
route class, HTTPS origins without credentials, resolver shape, allowed
qualities, and the default quality.

Keep `packages/space-config` until plan 02 removes its final caller.

### 2. Add the registry tables

Use generated identity integer primary keys for every table. Keep separate
unique constraints for the business identifiers:

- `spaces` — internal `id`, unique `space_id`, `route_class`, `status`, quality
  policy, timestamps, and `decommissioned_at`.
- `space_source_origins` — internal `id`, `space_id` foreign key, `origin`, and
  `path_prefix`; unique on the Space and normalized origin rule.
- `space_resolvers` — internal `id`, `space_id` foreign key, unique
  `resolver_id` inside the Space, resolver type, and allowed project IDs.
- `space_api_tokens` — internal `id`, `space_id` foreign key, label, globally
  unique token hash, display prefix, and use/revocation timestamps.
- `space_capability_keys` — internal `id`, `space_id` foreign key, unique key ID
  inside the Space, sealed key fields, acceptance timestamp, and disablement
  timestamp.
- `space_registry_metadata` — one row with the current generation. Every policy
  or credential write increments it in the same transaction.

Do not use a cross-table `CHECK` constraint for the rule that a private Space
has no resolver. Postgres `CHECK` constraints cannot inspect another table.
Enforce the rule in the repository transaction and with a database trigger so
direct SQL cannot create an invalid registry.

Add database triggers that reject changes to `spaces.space_id` and
`spaces.route_class`. The TypeScript repository must also omit these fields
from its update interface.

### 3. Add envelope encryption

Add `SHUTTER_ENCRYPTION_KEY` to Control configuration and keep it as
`preserve()` in Railway IaC. It is 32 bytes encoded as hex or base64url.

Seal capability keys with AES-256-GCM in Control. Use the public Space
identifier and capability key identifier as additional authenticated data. If
the encryption key is missing, key reads and writes return `503`; Control can
still serve its health route.

### 4. Add a deep registry module

Add an async `SpaceRegistry` interface in `apps/control/src/spaces/`. Keep the
Postgres and cryptography implementation behind this seam. Its operations cover:

- get one active Space policy;
- load one atomic Edge snapshot;
- create, edit, and decommission a Space;
- issue, verify, and revoke API tokens; and
- add and manage capability keys.

Each mutation runs in one transaction and increments the registry generation.
The test adapter and the Postgres adapter implement the same interface.

Shutter stores the set of Capability Keys that it accepts. It does not select
which key a consuming application uses to issue new capabilities. Rotation is
a manual operator process: add the new key to Shutter, update the application,
wait for old capabilities to expire, and then disable the old key in Shutter.
An operator can disable a compromised key immediately and accept that existing
capabilities for that key will fail.

## Verification

Run `pnpm check`. Add tests for:

- all unique constraints and foreign keys;
- immutable public identifiers and route classes;
- the private-Space resolver trigger;
- decommission behavior;
- generation increments in the same transaction as each write;
- encryption round trips and additional-authenticated-data rejection; and
- repository behavior against the existing testcontainers Postgres.

## Risk

The encryption format and authenticated-data fields must be correct before any
real key is stored. A later incompatible change would make stored keys unreadable.
