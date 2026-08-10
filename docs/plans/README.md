# Plans

Implementation plans for work that spans several pull requests. Each numbered
plan is one PR unless the plan says it is not scheduled. A plan is deleted once
its work has landed and its outcome is recorded in `docs/adr/` or
`docs/architecture.md`.

Open the [interactive plan](./index.html) for the visual explanation.

## Sequence

| Plan | PR scope | Priority |
| --- | --- | --- |
| [01 — Space registry schema](./01-space-registry-schema.md) | Identity keys, immutable route class, encryption, and database layer. | Now |
| [02 — Space registry cutover](./02-space-registry-cutover.md) | Direct Postgres reads, per-isolate Edge refresh, maintenance cutover, and tenant-data removal. | Now |
| [03 — Admin surface](./03-admin-surface.md) | Server-rendered Space and credential management in Control. | Now |
| [04 — Deployment portability](./04-deployment-portability.md) | Fresh-deploy inputs and deletion of two obsolete scripts. | Later |
| [05 — Media delivery](./05-media-delivery.md) | One Shutter hostname for original images, videos, PDFs, and optional image optimization. | After configuration |
| [06 — Deferred operations](./06-deferred.md) | Operator accounts, encryption-key tooling, and measured scaling work. | Not scheduled |

## Why

`packages/space-config/src/index.ts` contains real tenant policy in a public
repository. Space existence is also repeated in checked-in TypeScript,
`SPACE_API_TOKENS`, and `CAPABILITY_KEYS`, with no shared source of truth.

The target is simple: a self-hoster deploys Shutter, opens the admin page,
creates a Space, and configures the consuming application. They do not edit
Shutter code or paste Space policy JSON into Cloudflare.

## Accepted decisions

- The cutover can use a maintenance window of up to 10 minutes.
- Database tables use incrementing internal primary keys plus unique business
  constraints.
- A Space public identifier and route class are immutable. A route-class change
  uses a new Space and a new identifier.
- Control reads Postgres on each Space-scoped request. It has no policy cache in
  the first version.
- Edge fetches one atomic configuration snapshot from Control and keeps it for
  at most 60 seconds in each isolate. Workers KV is not required.
- `ADMIN_BOOTSTRAP_TOKEN` and other deployment values stay `preserve()`d in
  Railway IaC until plan 04.
- Capability-key rotation is manual. Add the new key to Shutter, update the
  application, wait for old capabilities to expire, and disable the old key.
- Plan 04 deletes `check-phase2-config.mjs` and `verify-v1.mjs`. The Edge
  boundary and workspace test-runner scripts remain.
- General media delivery is plan 05, after registry and admin work.

## Configuration ownership

Space policy and credentials belong in Postgres. Provider regions, custom
domains, storage bindings, and provider credentials belong in deployment
configuration. Versioned URL shapes, capability purposes, cache identity, and
maximum protocol lifetimes remain in code and contracts.

## Independent security work

Removing tenant values from `HEAD` does not remove them from git history. Treat
the current values as exposed. History rewriting and credential replacement are
independent operational work.
