# Configure Source Resolvers in the Space Registry

A Source Resolver is Space configuration that turns the reference in a v2
Delivery URL into an allowlisted fetch location. The registry stores two kinds.
A `template` resolver is an HTTPS URL with one placeholder per path segment or
hostname label, such as `https://{project}.ufs.sh/f/{file}`; a placeholder in
the hostname must list its allowed values so the set of hosts is finite. An
`s3` resolver names an S3-compatible endpoint, bucket, and key template, and
Control signs a short-lived presigned GET for each fetch. Every expansion of
either kind must sit inside the Space's existing `allowedSourceOrigins`, which
is what keeps the imgproxy allowlist, the Executor origin rules, and the Edge
locator check working unchanged. The UploadThing type is retired; its rows
become templates.

The `s3` kind amends ADR 0001, which said Shutter never stores source bucket
credentials. The reasons behind that rule still hold: Shutter learns nothing of
the application's authorization or media catalog, the application keeps
uploads, retention, and end-user access, and moving storage means editing one
resolver while every Source ID stays put. What changes is one read-only,
resolver-scoped credential that an operator supplies and can revoke. It is
sealed with `SHUTTER_ENCRYPTION_KEY` like a Capability Key, never appears in an
Edge snapshot, a log, or an admin page after creation, and only Control uses it.
Railway buckets in particular have no public object URLs, so a presigned URL
minted inside Railway is the only way any Shutter component can read one.

Source identity for a resolver source is `{resolverId}/{reference}`. The
resolver name is part of identity, so two resolvers given the same reference
never share cached bytes, and removing a resolver orphans its cache to expire
under ADR 0020. A JSON callback protocol, arbitrary substitution rules, wildcard
allowlists, and redirect modes were considered and rejected: a template pointing
at an application endpoint already covers "ask the application", and a presign
covers a private bucket with no application code at all.
