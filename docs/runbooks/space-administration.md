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
   path prefix per line.
4. For a public Space, enter each Source Resolver as
   `resolver-id:project-id,project-id`. Leave the field empty for a private
   Space.
5. Create the Space and record the new registry generation.
6. Issue an API token and a Capability Key from the Space page. Each full secret
   appears once. Copy it directly into the consuming application's secret store.
7. Wait until the latest Edge refresh generation is at least the new registry
   generation. Test one derivative before you send production traffic.

## Change policy

Open the Space and edit only its qualities, default quality, source origins, or
public-Space resolvers. The page does not offer controls for the identifier or
route class. If either immutable value must change, create a new Space, migrate
the application, and decommission the old Space.

After a save, note the new generation. Wait for Edge to report that generation
before you depend on the new policy. Control reads committed policy directly
from Postgres and does not wait for Edge.

## Decommission a Space

Stop the consuming application from submitting new work or minting new
capabilities. Use the Space's danger zone to decommission it. This immediately
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
for Derivative Store Master Preview reads. Review the result; do not widen it to
all sources.

Run `railway config plan`, review every change, then deploy imgproxy. The value
is process-start configuration, so a Space policy edit alone does not update
imgproxy. Keep private, loopback, and link-local source access disabled.
