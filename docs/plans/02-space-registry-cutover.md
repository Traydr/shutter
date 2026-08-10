# Plan 02 — Space registry cutover

One PR, after plan 01. Control and Edge read the registry, Executors receive the
small policy fragment they need, and tenant data leaves the repository.

## Goal

Delete `packages/space-config`. Remove `SPACE_API_TOKENS`, `CAPABILITY_KEYS`,
and tenant policy JSON from deployment configuration. A policy or key change
reaches every active Edge isolate within 60 seconds.

The production cutover can use a maintenance window of up to 10 minutes. Do not
add dual reads or a zero-downtime compatibility layer.

## Not in scope

The admin surface, deployment portability, and general media delivery.

## Steps

### 1. Make Control read Postgres for each request

Replace synchronous `getSpacePolicy()` calls with async `SpaceRegistry` calls.
Do not add a Control in-memory policy cache. Each Space-scoped Control request
reads current policy from Postgres through the registry interface.

This supports multiple Control replicas without cache invalidation. If database
load later becomes measurable, optimize inside the registry module without
changing callers.

If Postgres is unavailable, return `503`. Return `404` only when a successful
query confirms that an active Space does not exist. Do not fail open.

### 2. Move API-token verification to the registry

Make `authorizedSpace()` call `SpaceRegistry.verifyApiToken()`. Remove
`SPACE_API_TOKENS` from Control environment parsing, `.env.example`, and
Railway IaC.

Hash the presented token and compare it in constant time. A revoked token fails
immediately. The `last_used_at` update must not delay the response.

### 3. Remove Space policy from Executors

Add the allowed source-origin rules to the claim that Control already issues.
Control obtains those rules from the current Space policy. Each Executor uses
the signed claim and no longer loads the whole Space registry.

Update the claim protocol, contract fixtures, Executor runtime, package
dependencies, and Railway watch patterns.

### 4. Add one atomic Edge snapshot endpoint

Add a versioned internal Control endpoint that returns one complete snapshot:

```json
{
  "schemaVersion": "v1",
  "generation": 42,
  "spaces": [],
  "capabilityKeys": {}
}
```

Read and validate the snapshot in one database transaction. Policies and keys
must become active together. Never serve a partial generation.

Protect the endpoint with a dedicated read-only `EDGE_CONFIG_TOKEN`. Do not
reuse the admin credential. Require HTTPS, reject redirects, and return
`Cache-Control: private, no-store`. Do not log the token, response body,
policies, keys, locators, or parser error text.

The current capability keys are symmetric. Edge uses them for verification,
but possession can also mint capabilities. Treat the complete snapshot as
secret key material.

### 5. Cache the snapshot in each Edge isolate

Keep one parsed immutable snapshot in module scope. It is local to one Worker
isolate; it is not shared by all isolates, all Cloudflare locations, or all
requests worldwide.

- From 0 through 45 seconds, use the local snapshot.
- From 45 through 60 seconds, use it and start one background refresh for that
  isolate with `ctx.waitUntil()`.
- At 60 seconds, or on a cold isolate, wait for Control before authorization.
- If refresh fails and no snapshot younger than 60 seconds exists, return
  `503` with `Cache-Control: private, no-store`.
- Return `404` only when a fresh valid snapshot confirms that the Space is
  absent.

Each cold isolate can call Control independently. Duplicate refreshes are safe.
Use a plain-data single-flight promise only as an isolate-local optimization,
and clear it in `finally`.

Fetch with `cache: "no-store"`, a short timeout, manual redirect handling, and
an explicit body limit of 1 MiB. Validate the schema version, generation,
identifiers, policy, and every key before one atomic swap. Keep no `Request`,
`Response`, stream, or other request-bound object in module scope.

Do not add Workers KV, Cache API storage, a Cron Trigger, or a Durable Object.
The detailed Cloudflare research is in
[`docs/research/edge-config-refresh.md`](../research/edge-config-refresh.md).

### 6. Perform the maintenance cutover

Use one short, explicit maintenance window:

1. Start maintenance mode and stop Space-scoped traffic.
2. Run the tested one-shot import against production Postgres. Import current
   policies, API-token hashes, and capability keys.
3. Read the snapshot back and compare it with the old deployed values.
4. Deploy Control, Executors, and Edge with the new registry path.
5. Confirm one old capability, one API token, one public route, and one private
   route.
6. End maintenance mode and remove the old environment values.

Do not ship a fallback to the checked-in registry. The import utility is a
cutover tool, not a permanent operator interface. Remove it after the cutover
or keep it outside runtime packages as a tested one-shot migration artifact.

### 7. Delete tenant configuration from the repository

Delete `packages/space-config`, its workspace entry, all package dependencies,
and its Edge-boundary root. Replace real identifiers in tests with fixtures such
as `example-public`, `example-private`, and `https://sources.example.com`.

### 8. Keep the imgproxy guard at deployment scope

`IMGPROXY_ALLOWED_SOURCES` is process-start configuration for imgproxy. Keep it
as a deployment-level allowlist and keep it as `preserve()` in Railway IaC.
Space origin rules remain the finer application policy.

The admin page in plan 03 will show whether every Space origin is covered by
this deployment allowlist. Do not widen it to all sources. Keep private,
loopback, and link-local address access disabled.

### 9. Update documentation and contracts

Update architecture, configuration, job-execution, and self-hosting documents.
Record the three ownership classes:

- Space configuration belongs in Postgres and the admin surface.
- Deployment configuration belongs in Railway and Cloudflare settings.
- Protocol invariants belong in versioned code and contracts.

Add an ADR for the database-backed Space registry and the strict 60-second Edge
snapshot rule. Keep script cleanup in plan 04.

## Verification

Run `pnpm check`, then test:

- Postgres unavailable versus Space absent (`503` versus `404`);
- cold Edge isolates and several independent isolates;
- concurrent refresh, soft refresh, hard expiry, and isolate eviction;
- invalid, oversized, timed-out, or mismatched snapshots;
- an API token and capability issued before cutover;
- public and private end-to-end requests; and
- the cutover against a copy of production before the maintenance window.

## Risks

Import correctness is the main cutover risk. A wrong capability key breaks
private URLs that are still valid. The Edge snapshot also contains every
capability key, so its endpoint credential, response, and logs need strict
treatment.
