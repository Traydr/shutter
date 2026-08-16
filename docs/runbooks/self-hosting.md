# Self-host Shutter

The committed Railway file (`.railway/railway.ts`) describes the service
topology and reads account-specific names, regions, and domains from the
environment. The committed Wrangler file (`apps/edge/wrangler.jsonc`) is the
Worker as deployed: name, custom domain, and R2 binding. A fork edits that file
for its own account like any other Worker project.

## Requirements

- A public fork or repository that Railway can build.
- A Railway account and workspace.
- A Cloudflare zone for the Control and Edge custom domains, and an R2 bucket
  with the lifecycle rule in `infra/cloudflare/r2-lifecycle.json`.
- Wrangler and Railway CLI sessions for the target accounts.
- Node 22, pnpm 11.1, and a running container runtime.

Run `pnpm check` before deployment.

## Railway

Copy `.railway/deployment.example.env` to `.railway/deployment.env` (Git
ignores it) and fill in the public values: project name, repository, region,
Control and Edge domains, the R2 bucket, endpoint, and region, the Cloudflare
zone, and the imgproxy source allowlist. The parser rejects unknown or
malformed values, and the file never holds a secret.

Plan whenever an input changes, read every resource, domain, region, variable,
and deletion, and apply only after that review:

```sh
set -a; source .railway/deployment.env; set +a
pnpm deployment:plan
pnpm deployment:apply
```

Credentials (`SHUTTER_ENCRYPTION_KEY`, `ADMIN_BOOTSTRAP_TOKEN`,
`ORIGIN_AUTH_TOKEN`, `EDGE_CONFIG_TOKEN`, the executor tokens, imgproxy
key/salt/secret, S3 keys, the Cloudflare purge token, and OTLP settings) are set
directly on the Railway services and never enter this repository. Once they
exist, set `SHUTTER_SECRETS_SEEDED=true` in the input so later plans
`preserve()` them instead of proposing their removal, and record the Postgres
volume name as `SHUTTER_JOBS_VOLUME_NAME` after the first apply so the plan
keeps declaring it.

## Edge

Edit `apps/edge/wrangler.jsonc` for your account: `name`, the `routes` custom
domain, and the `MEDIA_STORE` bucket. `MEDIA_STORE` and the Railway input
`SHUTTER_R2_BUCKET` (Control's `S3_BUCKET`) must name the same bucket: the
Worker writes optimized objects there and Control's Source Purge deletes them
from there. Set the three required secrets with
`wrangler secret put` (`ORIGIN_BASE_URL` is Control's public HTTPS origin), then
deploy the Worker only after Control reports healthy:

```sh
curl --fail --silent --show-error https://CONTROL_DOMAIN/healthz
pnpm deploy:edge
curl --fail --silent --show-error https://EDGE_DOMAIN/healthz
```

The Worker and Control share the internal optimize wire
(`/internal/v1/optimize-source` and `/internal/v1/optimize-master`), so a change
to either side of that wire deploys both in the same release: Control first,
then the Worker.

Cloudflare Workers Builds needs no build variables: its non-production command
is `pnpm --filter @shutter/edge deploy:preview` (`wrangler versions upload`)
and its production command is `pnpm --filter @shutter/edge deploy`.

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
the observation period ends. Roll back Edge alone only when the release did not
change the internal optimize wire; when it did, roll Control and the Worker back
together, in the same order they were deployed, because an old Worker sends a
query the new Control rejects and vice versa. Do not weaken capability checks.
Do not delete Postgres data or R2 objects while they are needed for diagnosis.
