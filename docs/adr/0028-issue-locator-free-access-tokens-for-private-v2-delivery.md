# Issue locator-free access tokens for private v2 delivery

A private Space serves the same v2 Delivery URL as a public one and adds a
`token` query parameter: the Source Capability envelope at version `v2`, with
the Space, Source ID, one purpose, an optional preview kind, and an expiry
inside, and no locator. The application mints it with the Capability Key it
already holds, after its own end-user authorization, and the Worker validates
it before every cache lookup as ADR 0008 requires. The purpose must match the
operation the query selects, so a delivery grant is not an optimization grant
and a preview grant binds its kind.

The locator left the token because a resolver already knows where the bytes
are (ADR 0025); what the application still owns is who may see them. Keeping
the AES-GCM envelope rather than switching to a signed token keeps one
primitive, one key registry, and one rotation procedure across v1 and v2.
Resolvers on private Spaces are allowed from this decision on; the earlier
rule that only a public Space could carry a resolver existed because a
resolver used to imply an unauthenticated route.

Tokenless private delivery through sessions or signed cookies is a separate
design with cross-origin rules of its own and stays out of v2.

The token authorizes Shutter's route, not the origin. A template resolver on a
private Space is fetched without credentials, so the origin itself must be
private for the Space to be; only an S3 resolver, whose credential stays sealed
in Control, makes a private Space private end to end. The runbook says so where
an operator adds a resolver.
