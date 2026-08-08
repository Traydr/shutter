# Plan 04 — Deferred work

Not scheduled. Recorded so the reasoning is not re-derived later. Nothing here
is required for plans 01 through 03 to be complete and useful.

## Configuration drift detection

Plans 02 and 03 leave the Edge configured by hand-pasted environment variables.
Nothing detects an operator editing a Space and forgetting to paste the result
into Cloudflare, at which point the Edge and the origin disagree about policy.

The cheap fix preserves the constraint that Railway must not depend on
Cloudflare: the Worker sends its configuration generation as a header on origin
requests, which it already authenticates with `ORIGIN_AUTH_TOKEN`. Control
compares it against the current generation and warns. The dependency direction
is Cloudflare to Railway, which is the direction that is allowed.

Near-free once plan 03 stamps generations.

## Edge auto-refresh

The Worker fetches policy and capability keys from Control instead of reading
environment variables, cached in the isolate with stale-while-revalidate.
Removes the paste step entirely.

Deliberately deferred, and it has a real cost worth restating before anyone
picks it up: capability key material would move onto the wire. Today the Worker
holds it as a Cloudflare secret; under auto-refresh, Control decrypts and serves
it over the origin channel. That is the same trust boundary `ORIGIN_AUTH_TOKEN`
already establishes, but a leak of one endpoint would expose every tenant's
minting key at once, which no single secret does today.

If it is built: split policy and keys into separate endpoints, give the key
endpoint a short time to live, hold it in isolate memory only, and never write
it to the Cache API. The harder variant ships ciphertext and gives the Worker
`SHUTTER_ENCRYPTION_KEY` too — better blast radius, at the cost of the
encryption key living in two clouds.

One genuine benefit beyond convenience: policy changes stop requiring a Worker
deploy, and a Control outage freezes policy rather than stopping renditions.

## Operator accounts

Plan 03 ships one bootstrap credential. Real accounts with per-Space scoping
matter when more than one person administers a deployment, or when a Space owner
should manage their own Space without seeing anyone else's. Roughly the
difference between a few days of work and a few weeks, which is why it is not
in plan 03.

Pairs naturally with moving the admin surface to its own hostname so it can be
firewalled separately from the job API.

## Encryption key rotation tooling

Plan 03 documents the procedure for rotating `SHUTTER_ENCRYPTION_KEY` and ships
no tooling. A command that unseals every `space_capability_keys` row under the
old key and re-seals under the new one, transactionally, would remove the
maintenance window. Worth building the first time it is actually needed.

## Multi-replica Control

Plan 02's registry is an in-process cache invalidated on write, which is correct
only because Control runs a single replica. Raising `replicas` in
`.railway/railway.ts` requires a real invalidation path first — listen/notify,
or a short time to live accepting bounded staleness. The constraint is recorded
in `docs/architecture.md` so the failure is not discovered in production.
