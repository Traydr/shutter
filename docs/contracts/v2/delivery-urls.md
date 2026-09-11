# V2 Delivery URLs

## Routes

```text
GET|HEAD /v2/{space}/{resolver}/{reference}
GET      /v2/{space}/{resolver}/{reference}?w={width}&q={quality}
GET      /v2/{space}/{resolver}/{reference}?preview={kind}&w={width}&q={quality}
```

`space` and `resolver` are lowercase identifiers. `reference` is one
percent-encoded path segment per placeholder in the named Source Resolver, in
placeholder order; see [source-resolvers.md](./source-resolvers.md) for the
segment grammar and how the reference becomes a Source ID. A reference with the
wrong number of segments, a segment outside the grammar, or a resolver the Space
does not have answers `404 Not Found`, as does an unknown Space.

The query selects the operation:

| Query | Operation | Methods |
| --- | --- | --- |
| none | Source Delivery of the original bytes | `GET`, `HEAD` |
| `w`, optional `q` | Image Optimization of the original | `GET` |
| `preview`, `w`, optional `q` | Image Optimization of the stored Master Preview | `GET` |

`preview` is exactly `video` or `pdf`. Any other combination, an unknown or
duplicated parameter, `q` without `w`, or `preview` without `w` returns an
uncacheable `400 Bad Request`. A method outside the table returns `405` with an
`Allow` header. A missing Master Preview returns an uncacheable `404`; a delivery
`GET` never creates a Preview Job.

Source Delivery keeps every rule of the v1 contract: the content-type allowlist,
bounded header pass-through, one byte range, conditional requests, the 512 MB
Cache API bound, and never writing an original to the Media Store. Image
Optimization keeps the v1 Optimization Policy: width is required, quality
defaults from the Space, and both normalize to canonical values.

## Canonical form

For a public Space, a valid non-canonical `w` or `q`, or an omitted `q`,
receives `308 Permanent Redirect` to the canonical query, which is `preview`
(when present) then `w` then `q`. A conforming client emits canonical values and
never sees the redirect. Private Spaces normalize internally and never redirect.

## Private Spaces

A private Space uses the same routes and additionally requires `token` on every
request. The Worker validates the token before any cache lookup, including
warm hits, and the token's purpose must match the operation the query selected.
The token format is defined in [access-token.md](./access-token.md). The
`token` parameter on a public Space is an unknown parameter and returns `400`.

## Identity and caching

Cache identity is the route class, Space ID, Source ID, input kind (source or
master-`kind`), and normalized width and quality; it never contains a locator,
credential, or token. A resolver source's Source ID is `{resolver}/{reference}`
with the decoded segments joined by `/`. Cache tags, R2 prefixes, Preview Jobs,
and Source Purge use that Source ID exactly as v1 uses an application-issued
one. Public responses keep the one-day browser and 30-day edge policy; private
responses are `private, no-store`.

Cache identity does not depend on the resolver's configuration. Editing a
resolver's endpoint, bucket, or credential does not invalidate cached bytes.
Changed bytes need a new reference.
