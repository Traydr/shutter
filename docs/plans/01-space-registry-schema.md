# Plan 01 — Space registry schema

One PR. Adds the database layer and the shared policy schema without changing a
single call site. Everything continues to read the checked-in policies, so this
lands with no behavioural change and no deployment risk.

## Goal

The tables, the envelope encryption, and the repository functions exist and are
tested. Nothing uses them yet.

## Not in scope

Reading the registry from Control, Edge, or the Executors; removing tenant data
from the repository; the admin surface. All of that is plan 02 onward.

## Steps

### 1. Move the policy schema into `@shutter/protocol`

`packages/space-config` holds two things: tenant data and a lookup function.
Once the data leaves, what remains is a zod schema and a parser — and
`packages/protocol/src/key-material.ts` already exports
`parseCapabilityKeyRegistry`, which does the identical job for the other
environment variable. They belong in one place.

Add to `packages/protocol/src/`:

- `spacePolicySchema` — a zod schema over the existing `SpacePolicy` union in
  `types.ts`, enforcing the discriminated `routeClass`, that private Spaces have
  no resolvers, that `defaultQuality` is a member of `qualities`, and that every
  allowed origin is HTTPS with no credentials.
- `parseSpacePolicies(raw: string): SpacePolicyRegistry` — mirrors the shape and
  failure behaviour of `parseCapabilityKeyRegistry`, returning a registry with a
  synchronous `get(spaceId)`.

Zod is pure JavaScript, so `scripts/check-edge-boundary.mjs` stays satisfied.
Do not delete `packages/space-config` in this PR — plan 02 removes it once the
last import is gone.

### 2. Schema migration

New tables in `apps/control/src/db/schema.ts`, following the existing
`renditionJobs` conventions (`text` identifiers, `timestamp` with time zone,
`check` constraints for enumerations):

- `spaces` — `id` text primary key, `route_class` with a check constraint of
  `('public', 'private')`, `qualities` integer array, `default_quality`,
  `created_at`, `updated_at`.
- `space_source_origins` — `space_id` foreign key, `origin`, `path_prefix`.
- `space_resolvers` — `space_id` foreign key, `resolver_id`, `type` checked
  against `('uploadthing')`, `allowed_project_ids` text array.
- `space_api_tokens` — `space_id` foreign key, `label`, `token_sha256`,
  `token_prefix` for display, `created_at`, `last_used_at`, `revoked_at`.
- `space_capability_keys` — `space_id` foreign key, `key_id`, `key_ciphertext`,
  `key_nonce`, `activated_at`, `retired_at`.

Foreign keys cascade on delete, so removing a Space removes its credentials.
A check constraint enforces that a private Space has no resolver rows.

Generate the migration with the existing drizzle setup. `db:migrate` already
runs in `preDeploy` in `.railway/railway.ts`, so no deployment change is needed.

### 3. Envelope encryption

`SHUTTER_ENCRYPTION_KEY` — 32 bytes, hex or base64url, validated the same way
capability keys already are in `packages/protocol/src/key-material.ts`. Add it
to `apps/control/src/env/server.ts` as an optional string, to `.env.example`,
and to `.railway/railway.ts` as `preserve()` on Control.

Capability key material is sealed with AES-256-GCM using `node:crypto`, in
Control only. The Space identifier and key identifier go in as additional
authenticated data, so a ciphertext cannot be moved between Spaces or key slots.

Fail-closed, matching the convention stated in `.env.example`: if the variable
is unset, capability-key reads and writes fail and their routes return 503,
while the rest of Control boots normally.

### 4. Repository functions

A new `apps/control/src/spaces/` module with the query and mutation functions —
create and delete a Space, replace its origins and resolvers, issue and revoke
API tokens, add and retire capability keys, and load the full policy set.

Token verification hashes the presented value with SHA-256 and compares in
constant time against `token_sha256`, rejects rows with `revoked_at` set, and
updates `last_used_at` without blocking the response.

Capability key retirement refuses to retire the last active key for a Space,
and records `retired_at` rather than deleting the row, so verification can
continue through the overlap window required by
[ADR-0013](../adr/0013-separate-space-api-and-capability-credentials.md).

## Files touched

- `packages/protocol/src/` — new schema and parser, exported from `index.ts`
- `apps/control/src/db/schema.ts` and a generated `drizzle/` migration
- `apps/control/src/spaces/` — new
- `apps/control/src/env/server.ts`, `.env.example`, `.railway/railway.ts`

## Verification

`pnpm check` passes unchanged, since no existing behaviour is touched. New unit
tests cover schema rejection cases, seal/unseal round trips including the
additional-authenticated-data rejection, and the repository functions against
the testcontainers Postgres already used by the Control suite.

## Risks

The migration adds tables and touches nothing existing, so it is reversible by
dropping them. The one thing to get right first time is the additional
authenticated data on the seal, because changing it later invalidates every
stored ciphertext.
