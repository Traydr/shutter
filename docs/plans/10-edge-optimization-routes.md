# Plan 10 — Edge optimization routes

One PR, after plan 08 (it changes what `fetchOrigin` sends). Give the five
Image Optimization routes the shape the three Source Delivery routes already
have: one registration module, one request-resolution step, and the route
classes as data.

## Goal

`apps/edge/src/optimization-routes.ts` mirrors `source-delivery-routes.ts`.
The rule "a public located capability gates the origin fetch, not the cache
hit" has one home with a name. Three delivery functions that only forward their
arguments are gone.

## Why

`deliverOptimizedImage` (`edge/app.ts:130-165`) is deep. Around it sit four
functions:

| Function | Body |
| --- | --- |
| `privateDelivery` | `return deliverOptimizedImage(bindings, identity, sourceUrl)` |
| `publicResolverDelivery` | identical |
| `publicMasterDelivery` | identical minus one argument |
| `publicLocatedDelivery` | the only one adding behaviour: a deferred verify closure |

The first three fail the deletion test — removing them changes four call sites
by one identifier each. The fourth earns its keep and is misnamed as a peer of
three aliases.

The five `spaceRoute` handlers (`:286-413`) each retype the same prologue:
`normalizeOptimizationQuery` → `if (!query.isCanonical) return
canonicalRedirect(...)` → a six-field `OptimizationCacheIdentity` literal. The
copies are not in the same order, and the difference is the design: on the
private routes `verifySourceCapability` runs *before* the canonical-redirect
check; on the public located route the redirect runs first and verification is
deferred into a closure that fires only on a cache miss (`:182-192`). That is
ADR 0015 — a public URL "excludes an encrypted presigned locator from
Cloudflare's canonical cache key" — and it is discoverable only by tracing a
closure three call levels down.

`registerSourceDeliveryRoutes` already solved this for Source Delivery: three
routes, one `deliverSource`, no aliases. The optimization routes predate it.

## Steps

### 1. `optimization-routes.ts`

Move the five `spaceRoute` registrations, `canonicalRedirect`,
`deliverOptimizedImage`, `populateCaches`, `fetchOrigin`, `fetchMasterOrigin`,
`readR2Response`, and `emitDeliveryEvent` into
`apps/edge/src/optimization-routes.ts` with one export,
`registerOptimizationRoutes(app)`. `app.ts` calls it beside
`registerSourceDeliveryRoutes(app)` and keeps only `healthz`, the cache-purge
route, and `authorizedOrigin`.

### 2. One resolution step

Inside the module, each route reduces to two decisions:

- **Subject** — how the route derives Source ID, input, and origin source: a
  resolver path (`resolveUploadThingSource`), a verified capability's claims,
  or a master path (`kind`, `sourceId`).
- **Capability gate** — when the Source Capability is verified relative to the
  cache lookup: `before` (private routes, verify then redirect then deliver),
  `on-miss` (public located, redirect then deliver, verify only if the origin
  must be fetched), or `none` (public resolver, public master).

One internal function takes the route's subject and gate, runs the prologue
once (normalize, canonical redirect, identity), and calls
`deliverOptimizedImage` with either a locator, a deferred locator, or nothing.
The three pass-through aliases are deleted; `publicLocatedDelivery` becomes the
`on-miss` branch of the one function.

Name the gate in code and document it once at its definition: a public located
URL is cacheable by anyone who holds it, so a hit is served without
verification and the capability is checked only before Shutter fetches an
application-owned Source Object. Do not add a `CONTEXT.md` term — ADR 0015
already states the rule; the plan gives it one home in code, not a new noun.

### 3. Tests

The existing `edge.worker.test.ts` cases already assert the load-bearing
orderings:

- "validates a private source capability before returning cached bytes";
- "excludes a public located-source capability from canonical cached
  identity" (a hit is served with `not-a-capability`);
- "fails a public located-source miss closed before contacting the origin".

Keep every case unchanged. Add one for each of the two private routes proving
a bad capability on a non-canonical URL answers 403, not 308, so the `before`
gate is pinned and cannot silently drift to `on-miss` in a later edit.

## Verification

Run `pnpm check`. `edge/app.ts` is under 120 lines. Grep confirms
`normalizeOptimizationQuery` and `canonicalRedirect` each have one call site in
`apps/edge/src`.

## Risks

None to wire behaviour: no URL, header, cache key, or status changes. The risk
is the refactor itself reordering a gate; the two new tests exist to catch
that.
