# Review of the 2026-08-24 full audit

Reviewed document: `full-audit-sol-20260824.md`. Every one of the 19 accepted
recommendations was checked against the code at the same baseline; each cited
file and line was read, and the load-bearing claims were re-verified rather
than taken on faith.

Bottom line: the audit is accurate. Every evidence claim I checked holds,
including the small ones (the invalid client test fixture, the contract/test
redirect contradiction, the triple `build:packages` run). Nothing needs to be
discarded as wrong. What does need adjustment is emphasis: several impact
ratings are inflated, the ranking buries the only findings that are actual
behavior bugs today, and four recommendations are structural taste rather than
problems and can be deferred indefinitely.

## Verdict summary

| ID | Audit rank | Verdict | One-line reason |
|---|---|---|---|
| X01-2 | 13 | **Adopt — raise to top** | Real misclassification bug visible to users today |
| X01-1 | 14 | **Adopt — raise** | Unawaited heartbeats, no attempt deadline, Control fetches have no timeout at all |
| S01-1 | 6 | **Adopt** | Caller abort genuinely cannot cancel an in-flight request |
| C05-1 | 4 | **Adopt** | Unbounded I/O while holding a session advisory lock, confirmed |
| C07-2 | 3 | **Adopt** (impact: medium, not high) | Real, but the failure window is shutdown-only |
| T01-1 | 1 | **Adopt** | All claims confirmed; right choice for first slice |
| C04-1 | 2 | **Adopt** (impact: medium) | Value is fail-fast at boot, not the per-request cost |
| P04-1 | 5 | **Adopt with a design decision** | Correct, but decide unknown-failure-code tolerance first |
| C02-2 | 8 | **Adopt** | Confirmed; tests also skip the Drizzle journal, so they test a different path than prod |
| E04-1 | 7 | **Adopt** (impact: low-medium) | Real gap, but the exposed route is internal and token-gated |
| C03-1 | 10 | **Adopt** | Confirmed contradiction between `view.status` and its representation |
| D01-1 | 18 | **Adopt** | Both evidence points confirmed; needs a human ruling on the redirect contract |
| C01-1 | 19 | **Adopt** | Trivially true; correctly ranked last |
| C02-1 | 9 | **Adopt, lower priority** | App already fails closed at read; constraints are defense in depth with prod-migration risk |
| I01-1 | 17 | **Adopt as an ops task, gated** | Duplication confirmed; imgproxy S3 vars plausibly inert; live-infra audit must come first |
| P03-1 | 11 | **Downgrade to optional** | Evidence overstated: there is no repeated correlation recovery per request |
| P02-1 | 12 | **Defer** | Accurate description, but highest regression risk in the list for a readability payoff |
| E03-1 | 15 | **Defer / optional** | Real re-parsing, but cheap, local, and the module is already well decomposed and well tested |
| P05-1 | 16 | **Defer** | Runtime allowlist already prevents leakage; compile-time typing is not worth the blast radius |

The 10 skips and the rejected/demoted candidates all have sound reasoning;
nothing I read contradicts them. Two I could verify directly: `P02-2`'s
rejection is right (the client's `keyMaterial()` genuinely accepts and uses
`CryptoKey`), and the `retryable`/failure-code decoupling is real in both
executor `run-once` classifiers.

## Where I differ from the audit

### The ranking optimizes for simplification, not for what is broken

The audit's priority list leads with build hygiene (T01-1) and configuration
preparation (C04-1). Those are fine first slices for a refactoring campaign,
but only three findings describe behavior that is wrong for users **today**,
and they sit at ranks 6, 13, and 14:

- **X01-2** — confirmed end to end. `apps/executor-pdf/src/processor.ts`
  wraps every `runCommand` failure in
  `ProcessingFailure("source_corrupt", ...)`. A missing `pdfinfo`/`pdftoppm`
  binary, or the 30-second metadata timeout firing on a slow host, produces a
  terminal `source_corrupt` → `replace_source` verdict for a perfectly good
  document. That is a wrong answer served to an end user, not a structure
  problem. If only one finding gets scheduled, it should be this one.
- **X01-1** — confirmed, and slightly worse than the audit states: beyond the
  fire-and-forget `setInterval` heartbeat (unawaited, no 409 handling, calls
  can overlap), the executor's `control()` helper attaches **no timeout or
  signal to any fetch**, so claim, heartbeat, complete, and fail can all hang
  forever. The attempt-scope proposal is the right shape.
- **S01-1** — confirmed. In `waitForPreviewJob`, the caller's signal reaches
  only `sleep`; `#control` replaces it with `AbortSignal.timeout`, so an abort
  during a fetch does nothing, and a long `Retry-After` sleep or a fetch can
  overrun `maxWaitMs`. `AbortSignal.any` makes the fix cheap.

C05-1 and C07-2 are the next tier (real liveness holes with a narrow trigger
window), and both check out exactly as written — the purge really does run
unbounded S3 pagination plus two HTTP calls while holding
`pg_advisory_lock` on a dedicated pool client.

### Findings whose impact is overstated

- **P03-1** ("Edge routes repeatedly recover the same correlation") is not
  what the code shows. `policyFor` is called exactly once per request, in the
  shared `spaceRoute` prologue; `keysFor` is called once per handler that
  needs keys (5 call sites). Each is an O(1) map lookup. A combined
  `spaceFor()` is a mild ergonomic improvement, not "high impact". Do it only
  if P02-1 ever goes ahead and the call sites are being touched anyway.
- **P02-1** describes the capability options bag accurately (verified,
  including issuance calling `validateClaims` with dummy keys and a
  synthesized `https://invalid.shutter.invalid` origin). But this is the
  security kernel of the protocol, pinned by fixtures and cross-runtime
  conformance tests, and the payoff is readability. The audit's own risk note
  ("preserve error codes and validation precedence") is the reason not to do
  it. Defer until this code must change for a functional reason.
- **E03-1**: the re-parsing is real (`parseRequestedRange`/`parseContentRange`
  are re-invoked across validation, origin checking, warming, and telemetry),
  but each helper is small, pure, and independently tested, and header
  re-parsing is cheap. Rewriting a 461-line module with exact 206/304/416
  semantics is where new bugs come from. The audit's medium confidence is the
  honest part; I would treat this as optional.
- **P05-1**: correct description, but the existing per-field allowlist with
  runtime sanitization already achieves the security property (nothing
  malformed reaches a sink). The registry buys compile-time event/field
  correlation at the cost of touching every event-building call site in
  Control, Edge, and both executors. Defer; if the executor track (X01) adds
  new failure taxonomy anyway, revisit afterwards.
- **C04-1** and **E04-1** are both right but modest: C04-1's per-request
  reparse is measured in microseconds (the real value is failing at boot on a
  malformed key), and E04-1's uncovered throw path is an internal,
  bearer-token-gated purge route whose worst case is Hono's default 500
  without `no-store`. Both are small enough to do anyway.
- **C02-1**: the audit rates impact high, but the application already fails
  closed at read time — `jobRepresentation` maps a malformed ready row to a
  terminal `internal_invariant` failure. Status-keyed check constraints are
  good defense in depth, and the write-time guarantee has value, but this
  carries the real migration risk the audit itself flags (existing prod
  rows). Do it after C02-2, without urgency.

### P04-1 needs one design decision the audit under-weights

The finding is fully confirmed, including the detail that
`packages/client/src/index.test.ts:117` pairs `source_expired` with a
nonexistent action (`resubmit_with_fresh_capability`; the protocol says
`renew_capability`). But moving to the protocol's closed
`FailedJobRepresentation` union means a **newer Control shipping a new
failure code breaks older clients**, which today degrade gracefully by
passing the strings through. Before implementing, decide the tolerance
policy explicitly — for example: enforce the code/action correlation for
known codes, and map unknown codes to a forward-compatible fallback rather
than a parse error. Separately, the test fixture is a one-line fix worth
making immediately, with or without the refactor.

### I01-1 is an operations change wearing a refactor's clothes

The duplication is confirmed (S3 credentials preserved into four services,
imgproxy signing credentials preserved twice), and the claim that imgproxy's
S3 variables are inert is plausible: `IMGPROXY_USE_S3` is never set, and
Control's `validateOptimization` only ever signs `https:` sources, so
imgproxy should never see an `s3://` URL. But `preserve()` means the live
values are the source of truth, and converting to `ref()` changes the
dependency graph and rollout order. The audit's gating (read-only equality
audit, reviewed plan, staged rollout) is exactly right — treat this as
scheduled infrastructure work, not part of the code-cleanup queue.

### D01-1 evidence, re-verified

Both claims hold and one is subtler than stated:

- `docs/plans/README.md` still lists landed plans as "Now"/"Next" and
  references `packages/space-config/src/index.ts`. That path is gone from
  git; what remains on disk under `packages/space-config/` is only untracked
  `dist/` and `node_modules/` leftovers, which are themselves a deletion
  candidate worth folding into this cleanup.
- The private-redirect contradiction is real: `docs/contracts/v1/
  delivery-urls.md` says private routes serve "without a normalization
  redirect", while `optimize()` in `apps/edge/src/optimization-routes.ts`
  issues a 308 for any non-canonical query regardless of route class, and
  `edge.worker.test.ts:94` explicitly pins capability-verification-before-
  private-redirect. The audit is right that this needs a human ruling on
  which is intended before either the contract or the Worker changes.

## Suggested order of work

If the goal is fixing what is wrong before improving what is inelegant:

1. **Immediate, tiny:** fix the invalid client test fixture; delete the
   untracked `packages/space-config` leftovers.
2. **Behavior bugs:** X01-2 (failure taxonomy), then X01-1 (attempt scope,
   including timeouts on `control()` fetches), then S01-1.
3. **Liveness under operations:** C05-1, C07-2.
4. **Hygiene with compounding payoff:** T01-1, C04-1, C02-2, E04-1.
5. **Protocol/API tightening:** P04-1 (after the tolerance decision), C03-1,
   C02-1.
6. **Docs and ops:** D01-1 (redirect ruling first), I01-1 (after the live
   equality audit).
7. **Only if convenient later:** P03-1, P02-1, E03-1, P05-1, C01-1.

## What the audit got right that deserves credit

The rejected-candidates list is the strongest part of the document: declining
to wrap two-caller branching in unions (C04-2), refusing speculative
single-flight caches (E03-2, Edge render), and keeping `retryable`
independent of failure codes are all correct calls that match this repo's
deep-module standards. The skip list is similarly disciplined — C06's
"lockout ordering is load-bearing security behavior" and T03's "missing rule
fixtures are a test-coverage concern, not a structural one" are the right
kind of restraint. The coverage bookkeeping (246 paths, no overlaps) also
made this review materially easier to conduct.
