# Plan 08 — Optimize-source wire

One PR. Stop sending a formatted Delivery Cache key from Edge to Control on
`/internal/v1/optimize-source`; send the Space ID. Delete Control's hand parser
of the key layout.

## Goal

`packages/protocol/src/cache-identity.ts` is the only module that knows the
shape of a Delivery Cache key. Control never splits one.

## Why

`buildR2CacheKey` produces
`cache/v1/{routeClass}/{spaceId}/{fingerprint}/{input}/w{N}-q{N}.webp`. Edge
builds it, sends it as `?key=` to Control, and Control recovers the Space ID
with `spaceIdFromCacheKey` (`control/app.ts:82-100`) — a second, independent
copy of the layout, complete with a comment that must be kept in sync by hand.
`isCacheKey` (`:73-80`) is a third partial copy.

Control uses `key` for exactly three things: `isCacheKey`, `spaceIdFromCacheKey`,
and echoing it back as `x-shutter-cache-key`. Nothing reads that header —
Edge's `populateCaches` already holds the key it built. Control never touches
the Media Store on this route.

The only test pinning the two copies together is `app.test.ts:34`, which
hardcodes the fingerprint literal
`gMNnP86xbOKzyOCG34XyJJ5czSTAojiMAnH4AQSdh9s`. A layout change in protocol
breaks Control's Space lookup as a silent 400, and the test would still pass
against the stale literal.

The sibling route `/internal/v1/optimize-master` already takes
`{ spaceId, sourceId, kind, w, q }` and derives its Media Store key through
protocol (`app.ts:406`). This plan makes the source route match.

## Steps

### 1. Change the wire

`GET /internal/v1/optimize-source?space={spaceId}&source={locator}&w={N}&q={N}`

`space` replaces `key`. The response drops `x-shutter-cache-key`.

Add the query shape to `packages/protocol/src/control-routes.ts` next to
`CONTROL_HTTP_ROUTES`: one builder that takes `{ spaceId, sourceUrl, width,
quality }` and returns `URLSearchParams`, and one parser that returns the same
object or throws `ProtocolError("request_invalid")`. Edge and Control are two
callers of one internal wire; the wire belongs to the module both already
import. The parser owns the exact-key-set check and the strict positive-integer
check that `app.ts:255-284` does by hand today.

Protocol stays web-standard-only, so this passes `check-edge-boundary.mjs`.

### 2. Edge

`fetchOrigin` in `apps/edge/src/app.ts` takes `identity` instead of `key` and
uses the protocol builder. `populateCaches` still computes the key for the
Media Store write; it no longer passes it to the origin.

### 3. Control

Delete `isCacheKey`, `spaceIdFromCacheKey`, and `strictPositiveInteger` from
`control/app.ts`. The route calls the protocol parser, then `activeSpacePolicy`
with the parsed `spaceId`. Everything after the policy lookup is unchanged.

### 4. Tests

`app.test.ts`: `spikeUrl()` uses the protocol builder; the fingerprint literal
is gone. Add one case for a missing `space` and one for an unknown extra
parameter, both 400 through the parser.

`edge.worker.test.ts` "renders source-route misses through the authenticated
origin": assert the origin request URL carries `space=example-private` and no
`key`.

Contract test in protocol: builder → parser round-trips; parser rejects
duplicate keys, unknown keys, and non-integer width.

### 5. Record

Add a sentence to `docs/architecture.md` under image delivery: the internal
optimize routes carry Space ID and Source Locator; the Delivery Cache key is
built and owned at the Edge. No ADR — ADR 0024 already establishes that the
internal origin routes are not public wire and that Worker and origin deploy
together.

## Verification

Run `pnpm check`. Grep confirms `cache/v1/` appears in `apps/control/src` only
in tests that construct Media Store keys through protocol. A workerd test
renders a private source miss end to end through the new query.

## Risks

Edge and Control must deploy together: an old Edge sends `key`, a new Control
answers 400. This is the same coupling ADR 0024 already accepted for the route
rename, and `docs/runbooks` should note it in the deploy order.

Removing `x-shutter-cache-key` is safe today — no consumer reads it — but it is
a header deletion, so state it in the PR.
