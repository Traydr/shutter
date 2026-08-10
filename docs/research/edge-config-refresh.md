# Edge configuration refresh

Evaluated 2026-08-09 for fetching Space policies and capability verification
keys from Control at request time.

## Decision

Workers KV is **not required**. Keep one parsed, immutable configuration
snapshot in module scope in each Worker isolate and treat it as an opportunistic
cache, not durable state. Refresh it from an authenticated Control endpoint on
demand, with a 60-second hard lifetime.

Use a soft refresh point before the hard expiry, for example:

- From 0 through 45 seconds, use the snapshot.
- From 45 through 60 seconds, use the still-valid snapshot and start one
  background refresh for that isolate.
- At 60 seconds, or on a cold isolate, wait for a refresh before authorizing the
  request. If it does not produce a valid snapshot, return `503`.

This is strict fail-closed behavior. It bounds use of removed origins, policies,
or verification keys to at most 60 seconds, but it also means that a Control
outage longer than the lifetime eventually stops Space-scoped Edge traffic. An
explicit stale grace period could trade revocation latency for availability; an
unbounded stale-while-revalidate fallback cannot honestly be called strict
fail-closed.

## Why isolate memory is sufficient

Cloudflare reuses an isolate for multiple, sometimes concurrent, requests, so a
module-level plain-data snapshot can eliminate most Control calls handled by
that isolate. Isolates are not guaranteed to be long-lived, however, and two
requests are not guaranteed to reach the same Worker instance. An isolate can
also be evicted at any time. Consequently, every cold isolate and every active
isolate after its own lifetime can fetch independently; there is no single
global refresh every minute. This is acceptable cache-miss behavior, not a
correctness dependency. [How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)

Store only parsed JavaScript data in module scope. Do not retain a `Request`,
`Response`, body stream, or another I/O object across requests: Cloudflare ties
those objects to the invocation that created them and rejects cross-request
use. The current compatibility behavior schedules cross-request promise
continuations in their correct live request context. An isolate-local
single-flight promise can therefore be tested as an optimization, but it must
resolve to plain data, be kept alive by the initiating request, and be cleared
in `finally`; occasional duplicate refreshes are otherwise harmless and safer
than making cross-request promise sharing a correctness requirement. Cover the
concurrent path with a `workerd` test. [Workers errors and exceptions](https://developers.cloudflare.com/workers/observability/errors/),
[Workers compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)

`ctx.waitUntil()` is appropriate only while a still-valid snapshot can satisfy
the current response. It lets the refresh continue for at most 30 seconds after
the response finishes. When the request needs the new configuration to decide
authorization, await the refresh instead. Give the Control fetch its own much
shorter timeout. [Context API](https://developers.cloudflare.com/workers/runtime-apis/context/)

Cloudflare's Cache API does not implement the `stale-while-revalidate` or
`stale-if-error` directives for `cache.put()`/`cache.match()`. The timing above
must therefore be application logic even if the Cache API were used.
[Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)

## Snapshot protocol and security

Prefer one authenticated endpoint returning one atomically generated snapshot:

```json
{
  "schemaVersion": "v1",
  "generation": 42,
  "spaces": [],
  "verificationKeys": {}
}
```

Policies and keys must become active together. If they are exposed through
separate endpoints, make each response name the same immutable generation and
install neither response unless both generations match. Never partially update
the live snapshot.

Use a dedicated read-only credential for this endpoint, provisioned as a Worker
secret, rather than a general administrative credential. Send it only over
HTTPS and reject redirects so an authorization header cannot be forwarded to a
different host. Request the snapshot with `cache: "no-store"`; Control must
also return `Cache-Control: private, no-store`. Cloudflare documents secrets as
the binding for API keys and authentication tokens, and documents `no-store` as
the directive for secret assets that no cache may retain. Shutter's current
"verification keys" are symmetric AES-GCM decryption keys and can also mint
capabilities, so they are secret key material rather than public verification
keys.
[Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[external-service authentication](https://developers.cloudflare.com/workers/configuration/integrations/external-services/),
[Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/),
[Cloudflare Cache-Control](https://developers.cloudflare.com/cache/concepts/cache-control/)

Before installing a response, require all of the following:

- successful authenticated status and expected content type;
- a small, explicit Shutter byte ceiling checked while reading the body;
- supported schema version and complete schema validation;
- one internally consistent generation; and
- no duplicate identifiers, missing verification state, or invalid key
  material.

Do not log the endpoint credential, response body, policies, keys, locators, or
parser error text. Safe operational fields are the generation, snapshot age,
refresh outcome, and an allowlisted failure code.

## Why not Cache API or KV

| Storage | Assessment |
| --- | --- |
| Isolate memory | Recommended. Fast, transient, and sufficient for a 60-second best-effort cache. It is duplicated per isolate and disappears on eviction, which the cold-refresh path must already handle. |
| Cache API | Do not use for capability keys. It is an HTTP response cache local to one data center, does not replicate or use Tiered Cache, and local deletion does not purge other data centers. Persisting the key response would also require overriding the `no-store` treatment Cloudflare recommends for secret assets. It offers little origin-load benefit over isolate memory while leaving secret-bearing response objects in distributed caches. |
| Workers KV | Technically capable but unnecessary. KV encrypts values at rest and in transit and is intended for read-heavy configuration. It is nevertheless persistent, globally distributed secret storage with an additional API/operator surface. Reads are eventually consistent: updates can take 60 seconds or more to appear in other locations, including cached negative reads. Using KV would therefore not give a stronger 60-second revocation bound. |
| Durable Object | Could coordinate a globally named snapshot with stronger consistency, but adds a stateful service and a network hop. Consider it only if measured per-isolate refresh traffic becomes a real Control load problem. |

Sources:

- [How the Cache works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [How Workers KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [Workers KV data security](https://developers.cloudflare.com/kv/reference/data-security/)

KV becomes reasonable only if reducing Control fetch volume is worth persistent
Cloudflare storage and bounded eventual consistency. Having each Edge miss
write the same KV key is not a good intermediary design: same-key writes are
limited to one per second and concurrent isolates would race. A future KV design
should have one deliberate publisher, not opportunistic write-back from every
isolate. [Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/)

## Limits that affect the design

- A Worker isolate has 128 MB of memory and may handle many concurrent requests.
  The fetched response has no enforced body limit, but buffering can exhaust the
  isolate. Parsing JSON temporarily holds both text and decoded structures, so
  Shutter must impose a much smaller protocol limit; `1 MiB` is a conservative
  initial ceiling to validate against expected Space growth.
- A Control fetch is one subrequest. Workers Free allows 50 subrequests per
  invocation and Workers Paid defaults to 10,000. KV and Cache API operations
  also count as subrequests. At most six outgoing connections per invocation
  may be waiting for headers concurrently.
- Workers Free allows 10 ms CPU per request; Paid allows up to five minutes.
  Network wait is wall time, not CPU time, but JSON parsing and schema validation
  consume CPU. Measure the maximum accepted snapshot on the Free runtime before
  fixing its ceiling.
- The existing 5 KB per-environment-variable limit no longer constrains a
  fetched snapshot. It still applies to the endpoint URL and authentication
  secret individually.
- Where a Worker route exposes a fail-open/fail-closed setting, select
  fail-closed. Cloudflare explicitly recommends that mode for security-critical
  Workers when the daily request allowance is exceeded.

Source: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

## Failure semantics

| Condition | Edge behavior |
| --- | --- |
| Valid snapshot younger than 60 seconds | Use it. A failed soft refresh does not fail the current request. |
| Cold isolate or snapshot at least 60 seconds old | Await one refresh for that isolate. |
| Fetch timeout, network error, non-success status, oversized body, invalid schema/key, or inconsistent generation | Do not install it. Use the previous snapshot only if it is still younger than 60 seconds; otherwise return `503` with `Cache-Control: private, no-store`. |
| Valid snapshot does not contain the requested Space | Return `404`. This is different from registry unavailability. |
| Valid snapshot exists but capability validation fails | Preserve the existing protocol-specific `403` behavior. |

The live value should be replaced only after the entire candidate has validated.
Keeping the last good value in memory after expiry is useful for diagnostics,
but it must not participate in authorization under the strict policy.

## Recommended implementation scope

No KV namespace, Cache API entry, Cron Trigger, or Durable Object is needed for
the first implementation. Add only:

1. a versioned, authenticated Control snapshot endpoint with an atomic
   generation and `no-store` responses;
2. a dedicated Worker secret for read access;
3. an isolate-local immutable snapshot, soft/hard timing, and a plain-data
   single-flight refresh;
4. strict validation, response-size and fetch-time bounds, and the failure
   matrix above; and
5. tests for cold start, concurrent refresh, isolate loss, generation mismatch,
   malformed/oversized responses, timeout, soft-refresh failure, and hard-expiry
   failure.

Measure refresh requests per Control instance after rollout. Adopt a shared
Cloudflare store only if that measured traffic, rather than the correctness
model, requires one.
