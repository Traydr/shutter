# Plan 03 — Admin surface

One PR, depending on plan 02. Server-rendered Space management inside Control.

## Goal

A self-hoster deploys the template, opens the admin page, creates a Space, and
copies its credentials into their application. They author no JSON and edit no
TypeScript.

## Why it lives in Control

Control is already a Hono app with a database connection and a custom domain. A
separate `apps/admin` would mean another service in `.railway/railway.ts` and
another thing a self-hoster deploys, which is the tax this work exists to
remove. Server-rendered HTML from Hono keeps it to one service with no frontend
build step.

## Steps

### 1. Bootstrap authentication

A single operator credential, `ADMIN_BOOTSTRAP_TOKEN`, `preserve()`d in
`.railway/railway.ts` and generated on first deploy. Session cookie after
login — `Secure`, `HttpOnly`, `SameSite=Strict`, short expiry.

This is deliberately minimal. Real operator accounts with per-Space scoping are
plan 04. One credential is enough for a single-operator deployment and is the
difference between this PR being a few days and a few weeks.

Mount at `/admin` on Control's existing domain. Every route requires the
session; there is no unauthenticated surface beyond the login form. The admin
routes are registered separately from the job API so that a routing mistake
cannot expose one through the other.

### 2. Space management

Create, view, and delete Spaces. Edit route class, quality ladder, default
quality, source origins, and resolvers.

The identifier field is create-only and immutable afterwards, because it is
embedded in R2 keys (`cache/{space}/`, `masters/{space}/`) and in the
`rendition_jobs` primary key. The form says so.

Deleting a Space warns when unfinished `rendition_jobs` rows reference it, since
`docs/architecture.md` requires configuration to outlive any job that names it.
Cascading deletes remove its credentials with it.

### 3. Credential management

Issue an API token: generated server-side, displayed once, stored as a hash.
The list shows label, prefix, creation date, and last use. Revocation is
immediate.

Add a capability key: generated server-side, displayed once, sealed with
`SHUTTER_ENCRYPTION_KEY`. The list shows key identifier, activation date, and
state.

Retiring a capability key is where the UI earns its place. It refuses to retire
the last active key, and it explains the overlap window rather than leaving it
to tribal knowledge — a retired key must keep verifying until every capability
it minted has expired, up to the 24 hours fixed in
`docs/contracts/v1/rendition-policy.md`. The interface shows the earliest safe
retirement time and blocks the action until then.

### 4. Copy-out panel

The piece the Edge depends on, given that Railway does not talk to Cloudflare.

One page rendering:

- `SPACE_POLICIES` — the full policy JSON, for the Worker.
- `CAPABILITY_KEYS` — the unsealed key registry in the shape
  `{ "space-id": { "kid": "key" } }` the Worker already parses, for the Worker.
- `IMGPROXY_ALLOWED_SOURCES` — the origin list derived from every Space, for
  Railway.

Each with a copy button. Each stamped with a generation number that increments
on every write, so it is possible to tell what was last pasted where.

The panel warns when a Space's origins are not covered by the currently
configured `IMGPROXY_ALLOWED_SOURCES`, which is the one piece of policy that
cannot follow the database.

### 5. Runbooks

- Creating a Space and wiring an application to it — the plug-and-play path,
  written for someone who has never seen this repository.
- Rotating an API token.
- Rotating a capability key, including the overlap window.
- Rotating `SHUTTER_ENCRYPTION_KEY`. **Documented, not implemented.** It
  requires unsealing and re-sealing every `space_capability_keys` row, and no
  tooling ships for it. The runbook states the procedure and that it needs a
  maintenance window.

## Verification

Beyond unit and route tests: create a Space through the interface, paste the
rendered values into a local Worker and imgproxy, and render an image
end to end without touching a source file. That walk-through is the actual
acceptance criterion for the whole effort, and it belongs in the runbook.

## Risks

**An admin surface on the origin domain is new attack surface.** It sits behind
a bearer credential on the same host that serves the job API. Registering the
routes separately limits routing mistakes; a separate hostname would be
stronger and is plan 04.

**Credentials displayed once are lost once.** The interface must be explicit
that a token cannot be recovered, only replaced.
