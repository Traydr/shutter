# Plan 07 — Space Registry authorization

One PR. Deepen the `SpaceRegistry` module: one implementation of "load a
Space's authorization", every method inside the adapter contract, and admin
reads that ask for one Space instead of all of them.

## Goal

The security-critical `authorizeSpaceRequest` is pinned by the same contract
that pins every other registry method, on both adapters. The Postgres adapter
decrypts Capability Keys in one place. The Job API test that proves the 503
path does so through the registry interface, not by spying on one adapter's
private call graph.

## Why

`apps/control/src/spaces/registry.ts` exposes 18 methods. Four of them are
progressively narrower projections of one read:

| Method | Production callers |
| --- | --- |
| `getActiveSpacePolicy` | `control/app.ts` optimize routes |
| `getActiveSpaceAuthorization` | none — contract test only |
| `getSpaceAuthorization` | `job-api.ts` executor claim |
| `authorizeSpaceRequest` | `job-api.ts` Space-scoped routes |

`apps/control/test/space-registry-contract.ts` covers 16 of the 18 methods.
`authorizeSpaceRequest` and `withTransaction` are the two it omits, and
`authorizeSpaceRequest` is the one input to the Job API's 404/401/503 ladder.

`job-api.test.ts:273` proves the 503 path with
`vi.spyOn(spaceRegistry, "getActiveSpacePolicy")`. That works only because
`MemorySpaceRegistry.authorizeSpaceRequest` delegates through
`getActiveSpaceAuthorization` → `getActiveSpacePolicy`.
`PostgresSpaceRegistry.authorizeSpaceRequest` runs its own SQL and never calls
either. The test asserts a call graph production does not have.

The Postgres adapter opens sealed Capability Keys in three near-identical loops
(`#spaceAuthorization`, `authorizeSpaceRequest`, `#loadEdgeSnapshot`). Only the
snapshot loop tolerates an undecryptable row; the two per-request loops throw
and take down the whole Space.

`admin/app.ts:69` answers "one Space" with `listSpaces().find()`, a full
registry read plus a full policy parse per row, because the interface has no
single-Space record read.

## Steps

### 1. Collapse the read family

Delete `getActiveSpaceAuthorization`. It has no production caller; the contract
test that uses it moves to `authorizeSpaceRequest`.

Add `getSpace(spaceId): Promise<SpaceRecord | undefined>`. It returns the
record for any status. The admin `currentSpace` helper calls it directly and
`loadSpaceDetail` drops from four registry calls to three.

Keep `getActiveSpacePolicy` (internal origin routes need active-only policy
without keys), `getSpaceAuthorization` (an executor claim may complete work on
a decommissioned Space — ADR 0022 retention), and `authorizeSpaceRequest`.

The interface stays at 18 methods. The deepening is not fewer names; it is one
implementation behind the authorization names and one contract over all of them.

### 2. One Capability Key loader in the Postgres adapter

Replace the three decrypt loops with one private
`#openCapabilityKeys(client, spaceRecordId, publicSpaceId)`. It uses the
snapshot loop's tolerance everywhere: an undecryptable row is excluded and
logged, not thrown. The reasoning already written on the snapshot loop holds
for a per-request read too — capabilities signed with that key fail
verification, which is the same outcome as excluding it, without 503ing every
other key on the Space.

`#spaceAuthorization` and `authorizeSpaceRequest` call the helper after their
own record and token queries. `#loadEdgeSnapshot` keeps its one bulk query and
shares only the open-and-tolerate step, so the snapshot stays a single
repeatable-read pass.

### 3. Pin the adapters together

Add to `space-registry-contract.ts`:

- `authorizeSpaceRequest`: `missing` for an unknown Space and for a
  decommissioned Space; `unauthorized` for no token, a malformed token, a
  revoked token, and a token issued to a different Space; `authorized` with the
  policy and the currently accepted Capability Keys; a key disabled after issue
  is absent from the next answer.
- `getSpace`: returns the record for active and decommissioned Spaces,
  `undefined` for unknown.
- `withTransaction`: a thrown error inside `work` leaves the generation and
  Space list unchanged on both adapters.

Do not assert `lastUsedAt` timing in the contract. The Postgres adapter updates
it fire-and-forget on purpose ("usage metadata is advisory and must not delay
or fail authentication"); the memory adapter's synchronous update is an
implementation detail, not a contract.

Extend the existing Postgres-only test "fails Capability Key reads and writes
when encryption is not configured" to `authorizeSpaceRequest` and
`getSpaceAuthorization`. That behaviour is deliberately fail-closed and only the
Postgres adapter can be constructed without encryption, so it stays a Postgres
unit test rather than a contract case.

### 4. Test the Job API through the interface

Change `job-api.test.ts` "distinguishes a missing active Space from registry
unavailability" to reject from `authorizeSpaceRequest` itself. The 503 for
executor claim (`getSpaceAuthorization`) gets the same treatment. No test in
`apps/control` may spy on a registry method other than the one the code under
test calls.

### 5. Admin uses `getSpace`

`currentSpace` calls `getSpace` and throws the same `not_found`
`SpaceRegistryError` on `undefined`. `admin.test.ts` keeps its assertions; the
`listSpaces` spy in that file that counts registry reads is updated to the new
call shape.

## Verification

Run `pnpm check`. The contract suite runs against both adapters (Postgres via
the Docker-backed test global). Assert by grep that
`getActiveSpaceAuthorization` has no remaining reference and that
`postgres-registry.ts` contains exactly one call to `encryption.open`.

## Risks

Changing the undecryptable-key rule for per-request reads from "throw" to
"exclude and log" is a behaviour change on the Job API path: a Space with one
corrupted sealed key now authorizes with the remaining keys instead of
returning 503. That is the rule the Edge snapshot already applies, so Edge and
Control become consistent, but it must be stated in the PR.

`getSpace` returns decommissioned records. Callers that need "active only" must
keep using `getActiveSpacePolicy` or check `status`; the admin is the only
caller that wants both.
