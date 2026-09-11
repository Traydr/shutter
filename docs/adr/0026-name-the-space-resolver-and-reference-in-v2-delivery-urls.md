# Name the Space, resolver, and reference in v2 Delivery URLs

A v2 Delivery URL is `/v2/{space}/{resolver}/{reference}`. The reference has one
percent-encoded path segment per placeholder in the resolver, and nothing in the
path is a capability or a locator. The query selects the operation: no query is
Source Delivery, `w` with an optional `q` is Image Optimization, and
`preview=video|pdf` with `w` optimizes the stored Master Preview. A private
Space uses the same grammar and adds `token`, validated before any cache lookup
as ADR 0008 requires.

The `public` and `private` path segments of v1 are dropped. Route class is
immutable Space policy and the Edge enforces it before any handler runs; v1
needed the segment only because the capability sat in a different path position
per class. Operation by query rather than by path keeps one stable URL per
source from which every representation derives, which is what Unpic-style
transformers and the consumers' existing Bunny habits expect, and it stays
unambiguous when a reference spans several segments.

Cache identity is unchanged: the Space, the Source ID, the input kind, and the
normalized parameters. The v1 located, master, and private routes remain and are
served by the same Worker indefinitely. The two v1 `resolver/` routes are
removed; the Edge logs showed only crawler traffic on them, and keeping them
would have required a second Source ID rule beside the v2 one.
