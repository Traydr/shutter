# Plan 11 — API v2 and configurable Source Resolvers

Eight stacked PRs, merged together. Readable v2 Delivery URLs, two Source
Resolver kinds edited in the admin UI, jobs and purge without capabilities for
resolver sources, and locator-free private tokens. The full report with the
route board, the earlier plans it consolidates, and the rejected alternatives
is the 2026-09-09 HTML plan; this file is the checklist.

## Decisions

- URL grammar `/v2/{space}/{resolver}/{reference}`; the query selects the
  operation (ADR 0026).
- Two resolver kinds, `template` and `s3`; UploadThing is a preset that fills a
  template; the JSON callback resolver is not built (ADR 0025).
- Source ID is `{resolver}/{reference}`.
- Only Control holds resolver credentials. The Edge asks Control to presign S3
  references on a cold Source Delivery miss.
- v2 jobs and purge need only the Space API token; Control resolves at claim
  (ADR 0027).
- Private Spaces add `?token=`; the token carries no locator (ADR 0028, PR 7).
- The v1 located, master, and private routes stay. The v1 `resolver/` routes
  go: the Edge logs showed only crawler traffic.
- The retired `uploadthing` kind stays parseable in the protocol until the
  stack is deployed, because the Worker built from the stack tip must still
  accept the old Control's snapshot (see the deploy order). Migration 0003
  rewrites the rows; a follow-up removes the kind once no snapshot carries it.
- v2 JSON errors are RFC 9457 problems with a stable `code`.

## PR sequence

| PR | Scope | Accept when |
| --- | --- | --- |
| 0 | ADRs 0025–0027, this plan, `docs/contracts/v2/`, glossary | Reviewed |
| 1 | Protocol: resolver union, template parser and expander, reference grammar, Source ID rule, v2 URL builders and query parser, testkit fixtures | Every accept and reject case has a named message |
| 2 | Edge: `/v2/:spaceId/:resolverId/*` through one dispatcher; template expansion at the Edge; S3 through the v2 internal wire; v1 resolver routes deleted | v1 located, master, and private tests unchanged |
| 3 | Control: migration 0003, registry for both kinds with sealed credentials, presigner, `/internal/v2/optimize` and `/resolve`, resolver editor with Test | Snapshot never carries a secret |
| 4 | v1 Edge routes on the v2 internal wire; `/internal/v1/optimize-*` deleted | No locator in any query string |
| 5 | v2 job and purge routes, claim-time resolution, problem responses | A video under an S3 resolver reaches `ready` with no capability |
| 6 | `@shutter/client/urls`, v2 client methods, conformance fixtures; ernesta-next PR | ernesta serves every image from a v2 URL |
| 7 | v2 access tokens, token gate on private Spaces, client issuance, ADR 0028 | Expired token on a warm cache is refused |

## Deploy order

Control auto-deploys from `main` and runs `db:migrate` before it starts. The
Worker deploys only through `pnpm deploy:edge`. An old Worker that receives a
snapshot with a `template` resolver rejects the whole snapshot, keeps the last
valid one for at most 10 minutes, then answers 503. So:

1. `pnpm deploy:edge` from the stack tip before merging.
2. Confirm the refresh generation on the admin dashboard.
3. Merge the stack; migration 0003 rewrites the resolver rows.
4. Create the ernesta `media` resolver in the admin UI and run Test.
