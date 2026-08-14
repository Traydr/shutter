# Fold Rendition into Derivative

The original language called every derived visual form a Rendition and reserved
Derivative for the materialized, stored ones. That split carried little weight in
practice and the word Rendition never read naturally for this domain, so
Derivative now covers both cases, qualified as cached or materialized where the
distinction matters. Variant and Transformation were considered as replacements;
Derivative won because it was already in the language and names the artifact
plainly.

The fold changes no public wire behavior: v1 URLs, the job API, capability
purposes, error codes in the pinned contracts, and R2 object keys never
contained the word. It does rename the `rendition_jobs` table (migration
`0002_fold_rendition_into_derivative`), the `RENDITION_STORE` Worker binding,
the internal origin routes, and log event prefixes, so the Worker and the
Railway origin must deploy together after this lands. ADRs 0001–0023,
`docs/plans`, and `docs/research` keep the old term as historical records.
