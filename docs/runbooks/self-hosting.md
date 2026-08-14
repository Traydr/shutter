# Self-host Shutter

Shutter keeps deployment identity outside the repository. The committed Railway
file describes service topology. The committed Wrangler file describes the
local Worker runtime. A Git-ignored input file supplies account-specific names,
regions, domains, and storage bindings.

## Requirements

- A public fork or repository that Railway can build.
- A Railway account and workspace.
- A Cloudflare zone for the Control and Edge custom domains.
- Wrangler and Railway CLI sessions for the target accounts.
- Node 22, pnpm 11.1, OpenSSL, and a running container runtime.

Run `pnpm check` before deployment. Then start the guided setup:

```sh
scripts/bootstrap-deployment.sh
```

The wizard has six stages: deployment identity, Cloudflare storage, the first
Railway plan, an explicit apply pause, provider credentials, and final review.
It writes only public values to `.railway/deployment.env` and generates
`apps/edge/wrangler.deploy.jsonc`. Git ignores both files.
The local input records the exact Railway project and environment IDs after
the first read-only plan. Every later plan, apply, and variable write verifies
or explicitly names that target. The generated Wrangler file names the exact
Cloudflare account from the R2 endpoint.

## How the wizard tracks progress

There is no fresh/imported mode. The wizard records two independent facts in
the input file and derives everything from them and from live provider state:
`SHUTTER_JOBS_VOLUME_NAME`, discovered from Railway itself once the Postgres
volume exists, and `SHUTTER_SECRETS_SEEDED`, written once credential variables
exist on the providers.

For an empty Railway project, the first graph omits all credentials and lets
`postgres()` create its initial volume. Review the output of
`pnpm deployment:plan`. The wizard pauses while the operator runs
`pnpm deployment:apply` in another terminal. It never performs that apply.
After that apply, the wizard discovers and records the live volume name, so
every later plan declares it and can never propose deleting database storage.
For an existing live project, link it with `pnpm exec railway link` first; the
wizard then discovers the same facts from the live project.

The credential stage is idempotent. It reads Shutter-Control's live variables
first and reuses every value that already exists — it never regenerates a live
credential, so re-running the wizard cannot rotate `SHUTTER_ENCRYPTION_KEY` or
any other secret. Only absent values are generated (independent 32-byte
credentials from OpenSSL) or prompted for (provider-issued R2 and Cache Purge
credentials, read without echo). Values reach Railway and Wrangler over
standard input. The wizard does not write a credential to the input file or
print a value in a plan. It then asks before redeploying all four Railway
application services so their running processes receive the values.

`pnpm deployment:apply` refuses to run while live credentials exist but the
input does not yet record `SHUTTER_SECRETS_SEEDED=true`, so a plan built from
stale input cannot propose deleting them.

The input shape is documented in
[`.railway/deployment.example.env`](../../.railway/deployment.example.env). Do
not add secrets to this file. The parser rejects unknown keys.

## Review and deploy

Run a Railway plan whenever an input changes:

```sh
pnpm deployment:plan
```

Read every resource, domain, region, variable, and deletion. Apply only after
that review:

```sh
pnpm deployment:apply
```

Render and deploy the Worker only after Control reports healthy:

```sh
curl --fail --silent --show-error https://CONTROL_DOMAIN/healthz
pnpm deploy:edge
curl --fail --silent --show-error https://EDGE_DOMAIN/healthz
```

The Edge deploy command regenerates the ignored Wrangler file from the same
public input. The committed local config has no custom domain and uses a local
R2 bucket name.

Cloudflare Workers Builds runs `pnpm --filter @shutter/edge deploy:preview`,
which performs the same regeneration first. CI has no checkout of the ignored
input file, so set the public inputs from `.railway/deployment.env` as build
environment variables on the Workers Builds settings page. They contain no
secrets. Without them the deploy fails with "Missing .railway/deployment.env
and no SHUTTER_* variables are set".

## Registry and route acceptance

Open `https://CONTROL_DOMAIN/admin`. Create one public Space and one private
Space. Give each Space an API token and Capability Key. Use distinct test
sources whose origins are in the configured imgproxy allowlist.

For the public Space, request a valid public resolver, located-source, or
Master Preview URL. Confirm a successful response and then confirm a repeated
request uses an Edge or R2 hit. For the private Space, mint a short-lived Source
Capability and request the private source or Master Preview route. Confirm:

- the valid capability returns the expected bytes with `Cache-Control:
  private, no-store`;
- a changed, expired, or wrong-Space capability returns no bytes;
- a request without the Control origin token cannot read the private origin;
- a public request cannot use the private Space identifier; and
- the admin Edge status shows a recent successful refresh.

Use a disposable Source ID to test purge twice. Confirm both calls succeed and
that a later invalid capability cannot recover bytes from Edge or R2. Keep all
URLs, tokens, locators, account identifiers, and captured evidence in the
private operational record, not in this repository.

## Rollback

Keep the previous Worker version and previous application delivery path until
the observation period ends. Roll back Edge independently if authorization,
bytes, or cache behavior regresses. Do not weaken capability checks. Do not
delete Postgres data or R2 objects while they are needed for diagnosis.
