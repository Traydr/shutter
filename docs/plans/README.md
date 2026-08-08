# Plans

Implementation plans for work that spans several pull requests. Each numbered
plan is one PR. A plan is deleted once its work has landed and its outcome is
recorded in `docs/adr/` or `docs/architecture.md`.

## Move Space configuration out of the repository

| Plan | PR scope |
| --- | --- |
| [01 — Space registry schema](./01-space-registry-schema.md) | Schema, encryption, database layer. No call sites change. |
| [02 — Space registry cutover](./02-space-registry-cutover.md) | Control, Edge, and Executors read the registry. Tenant data leaves the repository. |
| [03 — Admin surface](./03-admin-surface.md) | Server-rendered Space management in Control, with credential issuing and copy-out. |
| [04 — Deferred work](./04-deferred.md) | Drift detection, Edge auto-refresh, operator accounts. Not scheduled. |

### Why

`packages/space-config/src/index.ts` holds two real tenants' policies —
`ernesta` and `pane-view` — including their storage origins and UploadThing
project identifiers, in a public MIT repository. `README.md` and
`docs/architecture.md` both describe those Spaces as illustrative demo values,
so the documentation and the code disagree.

Underneath that leak is a structural problem. "Which Spaces exist" is asserted
in three uncoordinated places — the checked-in TypeScript, the
`SPACE_API_TOKENS` environment variable, and the `CAPABILITY_KEYS` environment
variable — with no referential integrity between them. A typo in one produces a
silent 401 from another. Adding a Space means editing TypeScript, hand-writing
two JSON documents, updating `IMGPROXY_ALLOWED_SOURCES`, and redeploying three
services across two clouds.

The goal is that a self-hoster authors nothing. They deploy the template, open
the admin page, create a Space, and copy two credentials into their
application.

### Decisions taken before writing these plans

**Control's database is the authoring source; the Edge is configured by
generated environment variables.** Railway must not depend on Cloudflare. The
admin page renders the `SPACE_POLICIES` and `CAPABILITY_KEYS` JSON for the
operator to paste into Cloudflare. Automatic refresh at the Edge is deferred to
plan 04 and is not required for any of this to work.

**The API token and the capability key stay separate credentials**, as
[ADR-0013](../adr/0013-separate-space-api-and-capability-credentials.md)
already requires. They cannot be merged: an API token is only ever checked, so
it is stored as an unrecoverable hash, while a capability key is used to
decrypt and must be stored recoverably. They also revoke on incompatible
schedules — an API token revokes instantly, while a retired capability key must
keep verifying until every capability it minted has expired, up to 24 hours.
And only the capability key belongs on Cloudflare; the Worker has no business
holding a credential that authorises job submission and purge.

What gets unified is the *management surface*, not the cryptography. One Space
row, one page, both credentials issued together.

**Space identifiers are immutable.** They are embedded in R2 object keys
(`cache/{space}/`, `masters/{space}/`) and in the `rendition_jobs` primary key.
The admin surface offers create and delete, never rename.

**Encryption key rotation is documented, not implemented.** Rotating
`SHUTTER_ENCRYPTION_KEY` requires re-encrypting every stored capability key.
Plan 03 ships the runbook; the tooling is out of scope.

**`SHUTTER_ENCRYPTION_KEY`, not `SHUTTER_MASTER_KEY`.** "Master" already means
Master Preview throughout this codebase — the `masters/` prefix, the
`master_preview` capability purpose, `MasterPreviewDescriptor`, and the
`rendition_jobs.master_key` column, which is an R2 object key and not a secret.

### Work that is related but independent

The current tenant values are in the public git history and remain there after
any change to `HEAD`. Scrubbing them needs `git filter-repo` and a force push,
and the values should be assumed already exposed. This is not sequenced against
the plans above and can happen at any point.
