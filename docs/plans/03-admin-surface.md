# Plan 03 — Admin surface

One PR, after plan 02. Add server-rendered Space management inside Control.

## Goal

A self-hoster deploys Shutter, opens `/admin`, creates a Space, and copies the
new credentials into the consuming application. They do not edit TypeScript or
author policy JSON.

## Why it lives in Control

Control already owns the Space registry and database connection. A separate
admin application would add another deployment and another interface. Render
the small management surface from Hono with no frontend build step.

## Steps

### 1. Add bootstrap authentication

Use one `ADMIN_BOOTSTRAP_TOKEN`, kept as `preserve()` in Railway IaC and managed
by the operator. After login, use a short-lived `Secure`, `HttpOnly`,
`SameSite=Strict` session cookie.

Mount the interface at `/admin`. Register admin routes separately from public
and job routes. Only the login form is unauthenticated.

Automatic first-deploy credential generation and operator accounts are later
work. This plan keeps the current Railway `preserve()` model.

### 2. Manage Space policy

Create, view, edit, and decommission Spaces.

The public Space identifier and route class are create-only. Do not render an
edit control for either field. If an operator needs a different route class,
the interface tells them to create a new Space with a new identifier, migrate
the application, and decommission the old Space.

Allow edits to the quality policy, source origins, and public-Space resolvers.
Validate each write through the same `SpaceRegistry` interface used by runtime
callers. Show the new registry generation after a successful write.

Do not delete a Space or reuse its public identifier. Decommissioning blocks new
Space-scoped work but retains identity, policy history needed by unfinished
jobs, and credential audit fields.

### 3. Manage credentials

Issue an API token on the server, display it once, and store only its hash. Show
its label, prefix, creation time, last use, and revocation state. Revocation is
immediate.

Generate capability keys on the server, display them once for installation in
the consuming application, and seal them in Postgres. Show the key identifier,
acceptance time, and whether Shutter still accepts it.

Key rotation is manual and the consuming application owns its minting choice:

1. Add the new key to Shutter, so Shutter accepts old and new capabilities.
2. Install the new key in the consuming application and make it the minting key.
3. Wait 24 hours from the application cutover so old capabilities expire.
4. Disable the old key in Shutter.

Do not require an automatic handoff. For a compromised key, allow immediate
disablement with a clear warning that existing capabilities will fail.

### 4. Show deployment coverage and refresh status

Do not render `SPACE_POLICIES` or `CAPABILITY_KEYS` for copy into Cloudflare.
Plan 02 makes Edge pull one atomic snapshot from Control.

Show instead:

- the current registry generation;
- the latest successful Edge refresh generation and time, when reported;
- the derived `IMGPROXY_ALLOWED_SOURCES` value for manual Railway updates; and
- a warning for any Space origin that the deployment allowlist does not cover.

The deployment allowlist remains manual because imgproxy reads it at process
start.

### 5. Add runbooks

Write runbooks for:

- creating and decommissioning a Space;
- changing a mutable policy field;
- rotating an API token;
- rotating a capability key with the manual overlap process;
- updating `IMGPROXY_ALLOWED_SOURCES`; and
- rotating `SHUTTER_ENCRYPTION_KEY` in a maintenance window.

Encryption-key rotation tooling is not part of this plan.

## Verification

Run `pnpm check`. In an end-to-end acceptance test, create a Space, configure a
consuming application, wait for Edge to refresh, and render an image without
editing a repository file or pasting Space JSON into Cloudflare.

Also test immutable fields, decommissioning, session protection, one-time secret
display, CSRF protection, and deployment-allowlist warnings.

## Risks

The admin surface is security-sensitive because it can issue credentials and
change fetch policy. Keep it small, server-rendered, and separate from job
routes. A separate admin hostname and real operator accounts remain later work.
