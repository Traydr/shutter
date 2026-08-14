# Retire the Rendition umbrella term

The original language called every derived visual form a Rendition, with
Derivative for the stored subset. Neither word earned its keep: both are
umbrella nouns papering over three concepts that already had concrete names.
The language now uses those names directly. Image Optimization is the on-demand
resize-and-encode operation and its result is an optimized image; Master
Preview is the durable stored poster or cover, produced by a Preview Job, which
matches the wire's `preview_job` purpose and `/previews/{kind}` path; Delivery
names the URL and cache layer. Variant, Transformation, and a widened
Derivative were considered and rejected as either misaligned with Cloudflare's
established meanings or umbrellas again.

Storage is the Media Store, named for planned non-image media rather than
today's WebP-only contents. It has two regions with opposite retention rules:
the Delivery Cache (`cache/` prefix, disposable, lifecycle-expired) and the
Master Store (`masters/` prefix, durable, never cache-evicted), preserving the
distinction ADR 0010 draws.

The change touches no public wire behavior: v1 URLs, the job API, capability
purposes, contract error codes, and R2 object keys never contained the retired
words. It does rename the jobs table (`rendition_jobs` to `preview_jobs`,
migration 0002), the Worker's store binding (now `MEDIA_STORE`), the internal
origin routes (now `/internal/v1/optimize-source` and
`/internal/v1/optimize-master`, replacing a leftover `spike` name), and log
event prefixes, so the Worker and the Railway origin must deploy together after
this lands. ADRs 0001 through 0023, `docs/plans`, and `docs/research` keep the
old terms as historical records.
