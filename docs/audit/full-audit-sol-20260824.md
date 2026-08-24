# Canonical simplification audit

Audit baseline: commit `86c568e479a2b60f3a2d4bf8157899b66647d7a4`.

The repository remains unchanged. `git status --porcelain=v1` and `git diff --stat` were empty at completion. Per the audit-only instruction, I did not run tests, builds, formatters, migrations, commits, or deployments.

The final coverage contract contains 27 non-overlapping subsystems covering all 246 tracked paths:

- 17 subsystems contain recommendations.
- 10 subsystems are explicit skips.
- 19 recommendations survived validation.
- 7 candidates were rejected, demoted, or merged.

I used the repository’s deep-module criteria to reject abstractions that merely move branching behind another type or interface.

## Coverage contract

| ID | Subsystem and exact ownership boundary | Interfaces, call sites, and validation | Status |
|---|---|---|---|
| P01 | Protocol foundations: `packages/protocol` package files plus `src/{base64url,binary,json,key-material,errors,constants,index,types}.ts` | Public protocol exports; consumed by every app/package. Key tests: `key-material.test.ts` and cross-package compilation. | skip |
| P02 | Capability model and crypto: [capability.ts](/Users/traydr/dev/shutter/packages/protocol/src/capability.ts), `capability.test.ts`, `testing.ts` | `issueCapability`, `verifyCapability`, capability claims and test keys. Called by Edge routes, Control, Client, and testkit. | recommend |
| P03 | Space policy and parsed Edge snapshot: [space-policy.ts](/Users/traydr/dev/shutter/packages/protocol/src/space-policy.ts), [edge-config.ts](/Users/traydr/dev/shutter/packages/protocol/src/edge-config.ts), tests | `SpacePolicy`, `parseEdgeConfigSnapshot`, `policyFor`, `keysFor`; consumed by Edge snapshot and route handlers. | recommend |
| P04 | Preview Job and Control HTTP wire: `jobs.ts`, `control-routes.ts`, their tests | `PreviewJobRepresentation`, request parsing, route constants, failure-code/action mapping. Produced by Control and decoded by Client. | recommend |
| P05 | Normalization, URLs, cache identity, observability: `normalization*`, `urls.ts`, `cache-identity*`, [observability.ts](/Users/traydr/dev/shutter/packages/protocol/src/observability.ts) | Canonical IDs/URLs, cache keys, operational event sanitization; used throughout Control, Edge, and Executors. | recommend |
| S01 | Entire `packages/client/**` | Public `ShutterClient`, submit/get/wait operations. Tested by `src/index.test.ts`; calls Control Job API. | recommend |
| S02 | Entire `packages/testkit/**` | Cross-runtime protocol fixture and conformance API; consumed by Node and Worker tests. | skip |
| C01 | Space Registry: `apps/control/src/spaces/**`, `src/import-spaces.ts`, `test/space-registry-contract.ts` | `SpaceRegistry`, memory/Postgres adapters, import workflow, policy projection; called by admin, Edge refresh, optimization, and purge. | recommend |
| C02 | Database ownership: `src/db/**`, `drizzle/**`, `drizzle.config.ts`, `migrate.ts`, `postgres-test*.ts` | Drizzle schema, transactions, migrations, PostgreSQL test setup. Called by registry and Preview Job lifecycle. | recommend |
| C03 | Preview Job API and orchestration: `job-api*`, `preview-job-lifecycle*`, `executor-dispatch*` | Claim, heartbeat, complete, fail, recovery transitions and public Job API representation. | recommend |
| C04 | Optimization origin: `imgproxy*`, `optimize-routes*`, `origin-auth.ts` | imgproxy signing/delegation and internal optimization routes. Called from Control app registration. | recommend |
| C05 | Master storage and purge: `master-store*`, `source-purge*` | Presigned master reads and source-wide S3/Edge/Cloudflare purge. Called under lifecycle exclusion. | recommend |
| C06 | Entire `apps/control/src/admin/**` | Admin sessions, input parsing, rendering, deployment coverage. Extensively covered by `admin.test.ts`. | skip |
| C07 | Control process/runtime: `app*`, `index.ts`, `runtime*`, `env/**`, `logging*`, `edge-refresh-status*`, `recovery*`, `shutdown*`, Control package manifest/tsconfig | Runtime feature wiring, process startup, recovery scheduling, logging and shutdown. Calls C01 through C05. | recommend |
| E01 | Edge configuration lifecycle: `config-snapshot*` | Cached/in-flight snapshot loading and refresh; tested with Worker runtime behavior. | skip |
| E02 | Edge optimization route: `optimization-routes.ts` and relevant Worker route tests | Image/master capability gates and Control delegation. | skip |
| E03 | Source Delivery: `source-delivery*`, `source-delivery-routes.ts`, `source-resolution.ts` | Range parsing, origin validation, cache/warm decisions and response construction. | recommend |
| E04 | Edge application shell: `app.ts`, `index.ts`, `space-route.ts`, `http-responses.ts`, `edge-cache-policy.ts`, `edge.worker.test.ts`, Edge package/build configs | Route composition, error translation, HTTP policy and cache policy. | recommend |
| X01 | Entire `packages/executor-runtime/**` | Shared claim/process/upload/heartbeat/transition loop and command adapter. Called by both executor apps. | recommend |
| X02 | Entire `apps/executor-video/**` | Video processor, application and one-shot runner. Shared concerns are assigned to X01. | skip |
| X03 | Entire `apps/executor-pdf/**` | PDF processor, application and one-shot runner. Shared concerns are assigned to X01. | skip |
| I01 | Railway IaC: `.railway/**` and authoritative [deployment-config.test.ts](/Users/traydr/dev/shutter/test/deployment-config.test.ts) | `buildRailwayProject`, deployment input parser and generated resource graph. | recommend |
| I02 | Cloudflare/media platform configuration: `apps/edge/wrangler.jsonc`, generated Worker binding, `infra/**` | Worker/R2/imgproxy deployment contract. I01’s test lines 138–175 are cross-boundary validation, not shared ownership. | skip |
| T01 | Root build/test/CI tooling: `.env.example`, `.gitignore`, `.node-version`, `.github/**`, root package/workspace/lock/tsconfig/Biome files, `scripts/**`, `vitest.node.config.ts` | `pnpm check`, lint/typecheck/test/build orchestration and CI. | recommend |
| D01 | `docs/**`, root `README.md`, `CONTEXT.md`, `AGENTS.md`, `LICENSE` | Architecture, ADRs, contracts, plans, research, runbooks and contributor documentation. | recommend |
| T02 | `.agents/skills/railway-config/SKILL.md` | Repository-local agent workflow for editing and planning Railway IaC. | skip |
| T03 | `tools/oxlint/anti-slop/**` and `.oxlintrc.json` | Fifteen custom rule IDs consumed by root `lint`; shared AST/type helpers. | skip |

## Final priority ranking

| Priority | ID | Impact | Confidence | Effort | Blast radius | Dependencies |
|---|---|---:|---:|---:|---:|---|
| 1 | T01-1 | high | high | medium | low | First validation groundwork |
| 2 | C04-1 | high | high | small | low | Independent |
| 3 | C07-2 | high | high | medium | medium | Before other Control lifecycle changes |
| 4 | C05-1 | high | high | medium | medium | Independent |
| 5 | P04-1 | medium-high | high | medium | medium | Before S01-1 |
| 6 | S01-1 | medium-high | high | medium | low | After P04-1 |
| 7 | E04-1 | medium-high | high | small | low-medium | Before P03-1 |
| 8 | C02-2 | medium | high | small | low | Bundle with C02-1 |
| 9 | C02-1 | high | high | medium-large | high | Use C02-2 migration path |
| 10 | C03-1 | medium | high | small | low-medium | After C02-1 |
| 11 | P03-1 | high | high | medium | medium | After E04-1 |
| 12 | P02-1 | medium-high | high | medium | medium | Build on P03-1 |
| 13 | X01-2 | high | high | medium | medium | Same implementation track as X01-1 |
| 14 | X01-1 | high | high | medium-large | medium | Use X01-2’s typed causes |
| 15 | E03-1 | medium-high | medium | medium | medium | Before P05-1 |
| 16 | P05-1 | medium-high | high | large | high | After E03-1 and executor failure stabilization |
| 17 | I01-1 | high | medium | large | high | Staged credential migration |
| 18 | D01-1 | medium | high | medium | medium | Current behavior must be confirmed |
| 19 | C01-1 | low-medium | high | small | low | Independent |

## Accepted recommendations

### T01-1: Separate test tiers and give the aggregate command one preparation owner

- Verdict: recommend.
- Evidence/current complexity: [vitest.node.config.ts:5](/Users/traydr/dev/shutter/vitest.node.config.ts:5) gives every Node test the PostgreSQL global setup. [run-workspace-tests.mjs:3](/Users/traydr/dev/shutter/scripts/run-workspace-tests.mjs:3) skips the entire Node suite under `WORKERS_CI`, including portable protocol, client, executor, and deployment tests. Root scripts also rebuild packages before typecheck, both test suites, and the final build.
- Simpler representation: explicit portable Node, PostgreSQL integration, and workerd tiers. The aggregate `check` command owns one package-build prerequisite; standalone commands retain their own preparation.
- Scope: root `package.json`, Vitest configurations, workspace test runner, CI workflow, and development documentation.
- Risks: silently assigning a database test to the portable tier; breaking clean-checkout standalone commands.
- Existing validation: current Vitest suites and `pnpm check` command graph.
- Additional validation: a discovery guard for PostgreSQL-dependent imports, CI exercising portable tests without Docker, and a check that aggregate execution builds shared packages once.
- Confidence: high.

### C04-1: Prepare imgproxy configuration once

- Verdict: recommend.
- Evidence/current complexity: runtime readiness checks only variable presence at [runtime.ts:229](/Users/traydr/dev/shutter/apps/control/src/runtime.ts:229), while every request reparses the URL, decodes key/salt, and checks the secret at [imgproxy.ts:59](/Users/traydr/dev/shutter/apps/control/src/imgproxy.ts:59).
- Simpler representation: runtime construction produces an opaque prepared signer containing the validated origin, decoded key/salt, and bearer secret.
- Scope: `imgproxy.ts`, `runtime.ts`, their tests, and the small configuration interface consumed by optimization routes.
- Risks: decide explicitly whether malformed configured values fail process startup or disable only imgproxy; preserve byte-for-byte signatures and avoid shared mutable headers.
- Existing validation: imgproxy signature vectors and runtime feature tests.
- Additional validation: malformed URL/hex/secret startup cases and exact request signature/header tests.
- Confidence: high.

### C07-2: Make recovery shutdown awaitable

- Verdict: recommend.
- Evidence/current complexity: `startRecoverySweep` returns a synchronous timer cancellation handle at [recovery.ts:81](/Users/traydr/dev/shutter/apps/control/src/recovery.ts:81). An active sweep can continue after shutdown closes its pool and logger at [shutdown.ts:57](/Users/traydr/dev/shutter/apps/control/src/shutdown.ts:57).
- Simpler representation: a recovery lifecycle handle with `stopAndDrain(deadline)` that owns the current sweep, timer, and cancellation signal.
- Scope: `recovery.ts`, `shutdown.ts`, `index.ts`, dispatch cancellation, and lifecycle tests.
- Risks: Railway’s 15-second drain budget, cancellation during a Control transition, and logger-close ordering.
- Existing validation: scheduling and shutdown tests.
- Additional validation: shutdown during an active sweep, bounded drain expiry, no pool use after close, and logger-last ordering.
- Confidence: high.

### C05-1: Bound all purge I/O with one operation budget

- Verdict: recommend.
- Evidence/current complexity: S3 pagination/deletion and Edge/Cloudflare calls have no deadlines at [source-purge.ts:35](/Users/traydr/dev/shutter/apps/control/src/source-purge.ts:35). They execute while the lifecycle holds a session advisory lock at [preview-job-lifecycle.ts:445](/Users/traydr/dev/shutter/apps/control/src/preview-job-lifecycle.ts:445).
- Simpler representation: one purge deadline propagated to each S3 page, deletion batch, and HTTP request, with fresh child abort signals and bounded pagination.
- Scope: `source-purge.ts`, its dependency interfaces, and tests. Preserve the existing exclusion boundary.
- Risks: remote work can complete after local timeout; retries must remain idempotent. Avoid a sequence of individually bounded calls that is still unbounded overall.
- Existing validation: purge success/failure and lifecycle exclusion tests.
- Additional validation: abort at every external stage, multi-page deadline exhaustion, lock release, telemetry, and successful retry after ambiguous completion.
- Confidence: high.

### P04-1: Put Preview Job response decoding in protocol

- Verdict: recommend.
- Evidence/current complexity: protocol owns representation and failure correlation at [types.ts:107](/Users/traydr/dev/shutter/packages/protocol/src/types.ts:107), but Client implements a weaker decoder at [client/index.ts:124](/Users/traydr/dev/shutter/packages/client/src/index.ts:124). Its test accepts an invalid `source_expired` action at [index.test.ts:112](/Users/traydr/dev/shutter/packages/client/src/index.test.ts:112).
- Simpler representation: `parsePreviewJobRepresentation` in protocol enforces status-dependent fields and failure-code/action correlation. Client adds only HTTP metadata.
- Scope: protocol job module/tests and Client decoder/tests; wire format remains unchanged.
- Risks: stricter parsing may expose already-deployed response drift. Additional unknown response fields should remain forward-compatible.
- Existing validation: protocol job fixtures, Control API tests, and Client response tests.
- Additional validation: every status variant, every correlated failure, malformed combinations, and additive unknown fields.
- Confidence: high.

### S01-1: One cancellation and deadline budget for Client polling

- Verdict: recommend.
- Evidence/current complexity: caller cancellation reaches only sleep at [client/index.ts:336](/Users/traydr/dev/shutter/packages/client/src/index.ts:336); requests replace it with an unrelated timeout at [client/index.ts:363](/Users/traydr/dev/shutter/packages/client/src/index.ts:363). A fetch or `Retry-After` sleep can exceed `maxWaitMs`.
- Simpler representation: one operation budget combines caller cancellation, the overall wait deadline, and per-request limits. Sleep is capped to remaining time.
- Scope: `packages/client/src/index.ts` and its tests, after P04-1.
- Risks: cancellation race semantics and environment-specific fetch abort errors. Preserve the current rule that max-wait expiry returns the last active representation while caller abort rejects.
- Existing validation: submit/get/wait and polling interval tests.
- Additional validation: abort before and during PUT, sleep, and GET; `Retry-After` longer than the remaining budget; no request after deadline.
- Confidence: high.

### E04-1: Translate thrown Edge errors at application level

- Verdict: recommend.
- Evidence/current complexity: only `spaceRoute` catches errors at [space-route.ts:26](/Users/traydr/dev/shutter/apps/edge/src/space-route.ts:26). The internal purge route can throw from `cache.purge` outside that seam at [app.ts:47](/Users/traydr/dev/shutter/apps/edge/src/app.ts:47).
- Simpler representation: one Hono application error handler owns protocol-safe JSON, no-store headers, status, and logging; remove the duplicate route wrapper catch.
- Scope: Edge `app.ts`, `space-route.ts`, HTTP response helpers, and Worker tests.
- Risks: preserve deliberate `HTTPException` responses and distinguish protocol errors from unknown failures.
- Existing validation: Edge route/config failure tests.
- Additional validation: rejected purge operations, unknown exceptions, protocol exceptions, response headers, and redacted logging.
- Confidence: high.

### C02-2: Share the production migration runner with tests

- Verdict: recommend.
- Evidence/current complexity: production uses Drizzle migration metadata at [migrate.ts:10](/Users/traydr/dev/shutter/apps/control/src/migrate.ts:10); tests independently sort files and split SQL at [postgres-test.ts:28](/Users/traydr/dev/shutter/apps/control/src/postgres-test.ts:28).
- Simpler representation: one internal `migrateDatabase(pool)` function used by the CLI and PostgreSQL test setup.
- Scope: a database migration module, `migrate.ts`, PostgreSQL test setup, and build-path configuration.
- Risks: source versus compiled migration-directory resolution and journal compatibility.
- Existing validation: current migration-backed database tests.
- Additional validation: migrate an empty database twice, verify the Drizzle journal and triggers, and exercise the compiled CLI path.
- Confidence: high.

### C02-1: Enforce Preview Job state invariants in PostgreSQL

- Verdict: recommend.
- Evidence/current complexity: [schema.ts:129](/Users/traydr/dev/shutter/apps/control/src/db/schema.ts:129) stores status plus numerous independently nullable fields; existing checks cover enumerations and counters, not state correlation. Every transition manually clears and fills related columns, for example [preview-job-lifecycle.ts:257](/Users/traydr/dev/shutter/apps/control/src/preview-job-lifecycle.ts:257).
- Simpler representation: several readable, named status-keyed constraints for the active lease, next-attempt timestamp, ready master tuple, and terminal failure fields.
- Scope: Drizzle schema, generated migration/snapshots through the normal generator, lifecycle tests, and migration preflight/repair policy.
- Risks: existing malformed production rows and unreadable monolithic constraints. Migration must diagnose or repair historical rows before adding checks.
- Existing validation: lifecycle transition tests and current schema constraints.
- Additional validation: fresh and upgraded databases, every valid state, every invalid cross-state combination, and a production-data preflight query.
- Confidence: high.

### C03-1: Remove the duplicate Preview Job view status

- Verdict: recommend.
- Evidence/current complexity: `PreviewJobView` stores status beside a representation that already contains status at [preview-job-lifecycle.ts:66](/Users/traydr/dev/shutter/apps/control/src/preview-job-lifecycle.ts:66). Malformed ready metadata becomes a failed representation while the sibling status can remain `ready` at [preview-job-lifecycle.ts:131](/Users/traydr/dev/shutter/apps/control/src/preview-job-lifecycle.ts:131).
- Simpler representation: `representation.status` is the sole in-memory/API status.
- Scope: lifecycle view construction, Job API dispatch checks, and tests.
- Risks: preserve the current fail-closed representation of malformed persisted rows, particularly during migration.
- Existing validation: lifecycle and Job API tests.
- Additional validation: malformed ready/failed rows and dispatch decisions derived only from the representation.
- Confidence: high.

### P03-1: Use one correlated parsed Space snapshot lookup

- Verdict: recommend.
- Evidence/current complexity: parsing builds parallel policy and key maps at [edge-config.ts:145](/Users/traydr/dev/shutter/packages/protocol/src/edge-config.ts:145), with separate `policyFor` and copying `keysFor` calls at [edge-config.ts:163](/Users/traydr/dev/shutter/packages/protocol/src/edge-config.ts:163). Edge routes repeatedly recover the same correlation.
- Simpler representation: `spaceFor(id) -> { policy, capabilityKeys } | undefined` backed by one map.
- Scope: protocol Edge configuration model and Edge route call sites/tests. The wire snapshot remains unchanged.
- Risks: preserve defensive key-map ownership and distinguish missing Space from an active Space with no usable key.
- Existing validation: snapshot parsing and route authorization tests.
- Additional validation: missing/keyless Spaces, copy/immutability behavior, and consistent policy/key lookup after refresh.
- Confidence: high.

### P02-1: Make capability verification context purpose-specific

- Verdict: recommend.
- Evidence/current complexity: [capability.ts:29](/Users/traydr/dev/shutter/packages/protocol/src/capability.ts:29) exposes unrelated optional origins, Source ID, and kind in one options object. Issuance reuses verification with dummy keys and a synthesized origin at [capability.ts:282](/Users/traydr/dev/shutter/packages/protocol/src/capability.ts:282).
- Simpler representation: a purpose-discriminated verification context plus a separate intrinsic-claims validator. Do not add four pass-through wrapper functions.
- Scope: capability implementation/tests, protocol testing helpers, and Edge callers using P03-1’s correlated Space access.
- Risks: preserve error codes and validation precedence, especially master-preview kind behavior and empty-origin semantics.
- Existing validation: capability fixtures and cross-runtime conformance.
- Additional validation: compile-time rejection of irrelevant/missing context, all purpose variants, and unchanged failure ordering.
- Confidence: high.

### X01-2: Classify executor failure at the stage that owns it

- Verdict: recommend.
- Evidence/current complexity: one catch spans processing, upload, and Control completion at [executor-runtime/index.ts:108](/Users/traydr/dev/shutter/packages/executor-runtime/src/index.ts:108), then asks the media processor to classify every error. PDF and video catches turn command startup/timeout failures into source corruption, for example [executor-pdf processor.ts:38](/Users/traydr/dev/shutter/apps/executor-pdf/src/processor.ts:38).
- Simpler representation: discriminated command outcomes for spawn, timeout/cancel, and nonzero exit; runtime-owned failures are classified at download, processing, upload, and Control transition boundaries.
- Scope: executor runtime command adapter and attempt loop, both processors, one-shot runners, and tests. Protocol wire may remain compatible.
- Risks: not every nonzero media exit proves corrupt input; error details must remain redacted.
- Existing validation: processor and executor-runtime failure tests.
- Additional validation: missing binary, timeout, external cancellation, media exit, S3 failure, Control failure, and exact retryable/failure-code bodies.
- Confidence: high.

### X01-1: Give each claimed job one attempt scope

- Verdict: recommend.
- Evidence/current complexity: heartbeats are fire-and-forget `setInterval` work at [executor-runtime/index.ts:101](/Users/traydr/dev/shutter/packages/executor-runtime/src/index.ts:101). Download and each command have separate timers, so video fallback can consume multiple full command budgets; upload and completion are not inside one overall deadline.
- Simpler representation: an attempt scope owns the absolute deadline, cancellation cause, serialized heartbeat loop, temporary resources, processing, upload, transition, and cleanup.
- Scope: executor runtime `index.ts` and `media.ts`, both processors/adapters, and their tests.
- Risks: reliable child-process termination, cleanup on cancellation, heartbeat 409 policy, and a separate short budget for reporting terminal failure.
- Existing validation: heartbeat, download, command, upload, and processor tests.
- Additional validation: whole-attempt expiry across fallback commands, stale claim cancellation, no overlapping heartbeat calls, process termination, cleanup, and bounded final reporting.
- Confidence: high.

Implementation sequencing should define X01-2’s error taxonomy first, then wire X01-1’s scope and cancellation causes, and finally complete stage classification in the same workstream.

### E03-1: Parse Source Delivery into validated internal outcomes once

- Verdict: recommend.
- Evidence/current complexity: request range parsing and origin-response interpretation are repeated across validation, headers, telemetry, warming, cacheability, and response construction at [source-delivery.ts:116](/Users/traydr/dev/shutter/apps/edge/src/source-delivery.ts:116), [source-delivery.ts:295](/Users/traydr/dev/shutter/apps/edge/src/source-delivery.ts:295), and [source-delivery.ts:404](/Users/traydr/dev/shutter/apps/edge/src/source-delivery.ts:404).
- Simpler representation: private `ValidatedDeliveryRequest` and `ValidatedOrigin` unions for complete, partial, not-modified, and unsatisfied results. The same outcome must drive response and cache control flow, not only telemetry.
- Scope: `source-delivery.ts` and its Worker tests; no public protocol type.
- Risks: HTTP rejection precedence, streaming body ownership, and exact HEAD/206/304/416 semantics.
- Existing validation: extensive Source Delivery Worker tests.
- Additional validation: correlated Range/Content-Range cases, HEAD for every outcome, body reuse, cache/warm decisions, and telemetry from the same outcome.
- Confidence: medium.

### P05-1: Key operational payloads by event

- Verdict: recommend.
- Evidence/current complexity: every event accepts the same all-optional field bag at [observability.ts:42](/Users/traydr/dev/shutter/packages/protocol/src/observability.ts:42). Sanitization validates fields independently of event at [observability.ts:160](/Users/traydr/dev/shutter/packages/protocol/src/observability.ts:160).
- Simpler representation: a compact event-family registry derives a discriminated event-to-payload type and runtime schema while retaining existing event and field names.
- Scope: protocol observability, logging projection, and event-building call sites in Control, Edge, and Executors.
- Risks: some names, such as `executor.failed`, cover multiple legitimate families. Runtime sanitization must remain even after compile-time typing; dashboards must not see a wire-shape change.
- Existing validation: sanitizer, redaction, and logging tests.
- Additional validation: compile-time missing/extra field cases, runtime event-field correlation, every event family, and unchanged serialized output.
- Confidence: high.

### I01-1: Give each Railway credential family one owner

- Verdict: recommend, narrowed.
- Evidence/current complexity: S3 credentials are independently preserved into four services at [railway.ts:45](/Users/traydr/dev/shutter/.railway/railway.ts:45), [railway.ts:85](/Users/traydr/dev/shutter/.railway/railway.ts:85), [railway.ts:143](/Users/traydr/dev/shutter/.railway/railway.ts:143), and [railway.ts:165](/Users/traydr/dev/shutter/.railway/railway.ts:165). imgproxy signing credentials are separately preserved on imgproxy and Control at [railway.ts:54](/Users/traydr/dev/shutter/.railway/railway.ts:54) and [railway.ts:105](/Users/traydr/dev/shutter/.railway/railway.ts:105).
- Simpler representation: imgproxy owns `IMGPROXY_KEY/SALT/SECRET` and Control references it. Control owns S3 credentials and Executors reference Control. Remove S3 credentials from imgproxy because Control gives it presigned HTTPS master/source locators, not `s3://` locators.
- Scope: Railway graph, deployment test, example input, and self-hosting/imgproxy runbooks.
- Risks: live values may currently differ; Railway references change the dependency graph and rollout order. This must be staged after a read-only equality/plan audit.
- Existing validation: deployment graph tests and configuration plan workflow.
- Additional validation: seeded/unseeded graphs, absence of unused imgproxy S3 variables, no dependency cycle, credential-reference targets, and a reviewed non-destructive Railway plan.
- Confidence: medium.

### D01-1: Restore ownership of current documentation

- Verdict: recommend.
- Evidence/current complexity: [plans/README.md:3](/Users/traydr/dev/shutter/docs/plans/README.md:3) says landed plans should be deleted after their durable decisions are recorded, yet implemented plans remain marked “Now” and “Next” and reference removed paths such as `packages/space-config`. The delivery contract says private noncanonical routes serve without redirect at [delivery-urls.md:43](/Users/traydr/dev/shutter/docs/contracts/v1/delivery-urls.md:43), while the implemented Worker test expects a private redirect.
- Simpler ownership: retire landed plans into git history or an explicitly historical area, promote durable behavior into contracts/ADRs/architecture, and repair stale root layout entries.
- Scope: plans index/files, delivery contract, architecture/ADR cross-references, root README, and package inventory.
- Risks: losing useful rationale or accidentally treating the redirect discrepancy as authorization to change runtime behavior.
- Existing validation: current architecture/contracts and behavior-pinning Worker tests.
- Additional validation: path/link check, one authoritative current statement per behavior, and explicit human confirmation of the intended private redirect contract.
- Confidence: high.

### C01-1: Index child policy rows before assembling Spaces

- Verdict: recommend.
- Evidence/current complexity: [postgres-policy.ts:87](/Users/traydr/dev/shutter/apps/control/src/spaces/postgres-policy.ts:87) filters the complete origins and resolvers arrays once for every Space. Full Edge snapshot generation uses this all-Space path.
- Simpler representation: group each child query once into `Map<internalSpaceId, rows[]>`, then assemble each policy from indexed children. Complexity becomes linear in Spaces plus child rows.
- Scope: local Postgres policy loader and multi-Space tests; no public interface change.
- Risks: preserve query order and correct empty-child behavior.
- Existing validation: Postgres registry and Space contract tests.
- Additional validation: multiple Spaces with interleaved origins/resolvers, empty sets, stable serialized ordering, and query-count assertions.
- Confidence: high.

## Explicit skip decisions

| ID | Reason |
|---|---|
| P01 | The low-level encoders, parsers, key-material utilities, constants, and error model are already small and direct. No shared model would remove material state or branching. |
| S02 | Duplicated Node/workerd conformance runners validate different runtimes. Fixture artifacts are deliberately versioned. |
| C06 | The lockout record and one-time secret ordering are load-bearing security behavior and already covered by focused tests. |
| E01 | Cached, in-flight, stale, and absent snapshot states are all legitimate. `fetchedAt` and `generatedAt` carry distinct security meanings. |
| E02 | Existing capability-gate and origin-result unions already capture the important states. Single-flight rendering would add unmeasured isolate state. |
| X02 | Video-specific control flow is short. Material deadline/failure concerns belong to X01. |
| X03 | PDF-specific control flow is short. Material deadline/failure concerns belong to X01. |
| I02 | Wrangler and lifecycle JSON are intentionally committed deployment state; the Worker binding is generated. Sharing a TypeScript cache constant with external JSON would not create one real owner. |
| T02 | The Railway skill is linear operational guidance. Repetition between core rules and its final checklist is deliberate safety reinforcement. |
| T03 | Material cross-rule semantics are already in shared helpers. Remaining AST branches are rule-specific; a common semantic engine would couple and relocate complexity. The absence of dedicated rule fixtures is a test-coverage concern, not a structural simplification. |

## Rejected, demoted, and superseded candidates

- `P02-2`, byte-only capability key material: rejected. `CryptoKey` supports non-extractable and pre-imported Web Crypto keys; removing it would narrow a legitimate public choice.
- `C01` active/decommissioned record union: rejected. PostgreSQL already enforces the timestamp/status correlation, and the adapters construct valid records. The union would spread branching for little gain.
- `C04-2`, source/master optimization target union: rejected. With two callers, it mostly moves existing policy-dependent branching into the delegate.
- `C07-1`, aggregate executor readiness union: demoted. Claim-token and wake-endpoint availability are intentionally independent.
- `E03-2`, isolate-local warming single-flight: rejected without measured concurrent duplication.
- `I02-1`, shared cache-duration constants: rejected as standalone. TypeScript cannot own the external R2 JSON value, and the two lifetimes may legitimately diverge.
- `T01-2`, repeated package builds: merged into T01-1’s command-graph rewrite.
- Client-owned Preview Job decoder: superseded by P04-1.
- `P05-2`, deleting cache constants: superseded and then rejected with I02-1.
- Executor upload-state/ETag union: below the two-finding X01 limit and less material.
- Edge origin-render single-flight: rejected as speculative.
- Generated Worker binding, Drizzle snapshot, and topology-generator refactors: rejected because they target generated or deliberately portable state.
- Coupling `retryable` to an executor failure code: rejected because retry policy and failure classification are intentionally independent.
- Master-preview constant cleanup: too small to survive the materiality threshold.

## Dependencies and first implementation slices

The best first slices are:

1. T01-1, test tiers plus one aggregate preparation owner.
2. C04-1, prepared imgproxy configuration.
3. C07-2 and C05-1 as separate lifecycle/liveness changes.
4. P04-1 followed by S01-1 in the same client/protocol track.
5. E04-1, then P03-1 and P02-1 around the correlated Space snapshot interface.
6. C02-2 and C02-1 together, followed by C03-1.
7. X01-2 and X01-1 as one coordinated executor track.
8. E03-1 before P05-1 so telemetry consumes the stabilized delivery outcome rather than inventing a competing model.
9. I01-1 only after inspecting live credential equality and reviewing the Railway plan.
10. D01-1 in two steps: retire stale plans first, then reconcile behavioral contracts with confirmed runtime intent.

The dominant cross-cutting patterns were:

- One fact represented twice: Preview Job status, Space policy/key correlation, credentials.
- Async work without one lifecycle owner: polling, recovery, purge, executor attempts.
- Validation occurring after the boundary: imgproxy configuration and Job response decoding.
- Producers constrained only by convention: database state columns and telemetry event fields.
- Parallel production/test implementations: database migration execution and test orchestration.

## Audit log

- Read repository development, domain, architecture, ADR, contract, infrastructure, and package guidance.
- Established an initial 25-row inventory.
- Reviewed subsystems in bounded, non-overlapping batches with at most three worker lanes alongside the coordinator.
- Independently checked each proposed finding against implementation, interfaces, call sites, and tests.
- Ran fresh coverage/schema, duplication/materiality, and dependency-priority passes.
- The coverage pass found two genuine omissions: T02 and T03. They were added as new rows and reviewed explicitly.
- Reconciled path ownership so all 246 tracked paths map to one authoritative subsystem.
- Removed speculative state, generator refactors, branch relocation, and low-value consistency work.
- Normalized every surviving finding to the required evidence, representation, scope, risk, existing validation, additional validation, and confidence schema.
- Confirmed the worktree was still clean at commit `86c568e479a2b60f3a2d4bf8157899b66647d7a4`.