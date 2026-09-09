# Space administration

Control serves the operator interface at `/admin`. Configure Postgres,
`SHUTTER_ENCRYPTION_KEY`, and an `ADMIN_BOOTSTRAP_TOKEN` of at least 32 random
characters before you use it. A login creates a 15-minute Secure, HttpOnly,
SameSite=Strict session. All pages are non-cacheable.

## Create a Space

1. Open the public HTTPS Control URL at `/admin` and enter the bootstrap token.
2. Enter a new public Space identifier and select its route class. These values
   cannot change and a decommissioned identifier cannot be reused.
3. Enter allowed qualities, the default quality, and one HTTPS source origin or
   path prefix per line. Every Source Resolver you add later must expand inside
   these origins, so add the bucket or provider origin here first.
4. Create the Space and record the new registry generation.
5. Add Source Resolvers from the Resolvers section (see below). On a private
   Space every v2 request also needs an access token the application mints
   with its Capability Key. The token protects Shutter's route, not the origin:
   a template resolver is fetched without credentials, so anyone who learns a
   reference can read the original from the origin directly. Only an S3
   resolver, whose credential stays sealed in Control, keeps a private Space's
   bytes private end to end.
6. Issue an API token and a Capability Key from the Space page. Each full secret
   appears once. Copy it directly into the consuming application's secret store.
7. Wait until the latest Edge refresh generation is at least the new registry
   generation. Test one optimized image before you send production traffic.

## Add or change a Source Resolver

A Source Resolver turns the reference in a v2 Delivery URL,
`/v2/{space}/{resolver}/{reference}`, into a fetch location. Its identifier is
part of the Source ID of everything it serves, so it cannot change; removing a
resolver orphans its cached bytes and stored Master Previews. Source Purge
removes both; the 30-day lifecycle removes only the cached bytes, never a
Master Preview.

1. On the Space page, choose **+ Template**, **+ UploadThing**, or
   **+ S3 bucket** in the Resolvers section.
2. For a template, enter the HTTPS URL with one `{name}` per path segment or
   hostname label, such as `https://{project}.ufs.sh/f/{file}`. A placeholder
   in the hostname must list its allowed values in the Allowed values box, one
   `name=value,value` line per placeholder. The UploadThing preset fills the
   URL; you add the project ids.
3. For an S3 bucket, enter the endpoint origin, bucket, region, and key template
   (`{key}` or `originals/{key}`), keep path-style addressing for R2 and Railway
   buckets, and paste a read-only access key pair. The pair is sealed with
   `SHUTTER_ENCRYPTION_KEY`; only the access key ID is shown again. Railway
   buckets have no public object URLs, so this presigned path is the only way
   Shutter can read them.
4. Save. The editor refuses a resolver whose expansions could leave the
   Space's allowed source origins; add the origin to the policy first.
5. Type a sample reference into the Test panel. Control resolves it exactly as
   a request would and fetches its first byte; the panel shows the Source ID,
   the host, the status, and the content type, never a signed URL.
6. Wait for the Edge to report the new generation, then request the example
   Delivery URL shown on the editor page.

To rotate an S3 credential, open the resolver, paste the new pair, and save.
Presigned URLs live ten minutes, so no overlap window is needed. To retire a
resolver, type its identifier into the Remove panel.

## Change policy

Open the Space and edit only its qualities, default quality, or source origins.
Resolvers have their own editor and a policy save carries them through
unchanged. The page does not offer controls for the identifier or route class. If either immutable value must change, create a new Space, migrate
the application, and decommission the old Space.

After a save, note the new generation. Wait for Edge to report that generation
before you depend on the new policy. Control reads committed policy directly
from Postgres and does not wait for Edge.

## Decommission a Space

Stop the consuming application from submitting new work or minting new
capabilities. On the Space page, type the identifier into the Decommission
panel to confirm, then decommission it. This immediately
blocks new Space-scoped Control work and removes the Space from new Edge
snapshots. It does not delete the Space, free its identifier, or remove policy
and credential audit fields needed by unfinished work. Jobs that Shutter
accepted before decommissioning can still be claimed and completed.

## Rotate an API token

1. Issue a new token with a label that identifies its consumer.
2. Copy the one-time value into that application's secret store.
3. Deploy or restart the application and verify a request with the new token.
4. Revoke the old token on the Space page. Revocation is immediate for new
   Control requests.

## Rotate a Capability Key

For an ordinary rotation:

1. Generate a new key in Shutter. Shutter now accepts the old and new keys.
2. Copy the one-time value into the application and make it the minting key.
3. Record the application cutover time and wait 24 hours so old capabilities
   expire.
4. Disable the old key in Shutter.

For a compromised key, disable it immediately. Existing capabilities that use
that key will fail. Do not wait for the overlap window.

## Update the imgproxy source allowlist

The dashboard derives the Space portion of `IMGPROXY_ALLOWED_SOURCES` and lists
active Space origins that the deployed value does not cover. Copy the derived
value into the Railway variable, while retaining any additional source needed
for Media Store Master Preview reads. Review the result; do not widen it to
all sources.

Run `railway config plan`, review every change, then deploy imgproxy. The value
is process-start configuration, so a Space policy edit alone does not update
imgproxy. Keep private, loopback, and link-local source access disabled.
