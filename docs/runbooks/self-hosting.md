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

## Fresh and imported modes

Use `fresh` only for an empty Railway project. The first graph omits all
credentials and lets `postgres()` create its initial volume. Review the output
of `pnpm deployment:plan`. The wizard pauses while the operator runs
`pnpm deployment:apply` in another terminal. It never performs that apply.

After the first apply, the wizard generates independent 32-byte credentials
with OpenSSL. It sends them to Railway with standard input and sends the shared
Edge credentials to Wrangler with standard input. Provider-issued R2 and Cache
Purge credentials are read without echo and sent the same way. The wizard does
not write a credential to the input file or print a value in a plan. It then
asks before redeploying all four Railway application services so their running
processes receive the new values.

Use `imported` for an existing live project. Supply the existing Postgres
volume name. Railway values use `preserve()`, and the wizard does not read,
generate, or replace credentials. The named volume remains in the desired
graph so a later plan cannot remove imported database storage.

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
