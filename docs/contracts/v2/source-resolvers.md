# V2 Source Resolvers

A Source Resolver is part of a Space policy. It turns the reference segments of
a v2 Delivery URL into an allowlisted HTTPS fetch location. There are two kinds.

## Template

```json
{
  "id": "ut",
  "type": "template",
  "url": "https://{project}.ufs.sh/f/{file}",
  "placeholders": {
    "project": { "allowed": ["ernesta_prod", "ernesta_staging"] },
    "file": {}
  }
}
```

- `url` is an absolute `https:` URL with no credentials, query, or fragment.
- A placeholder is `{name}` and occupies exactly one whole path segment or one
  whole hostname label. Each name appears once, names are lowercase
  identifiers, and the URL has at least one placeholder.
- At most one placeholder may sit in the hostname, and it must carry a
  non-empty `allowed` list. Each allowed value is a hostname label,
  `[A-Za-z0-9_-]{1,63}`; `_` is tolerated because existing UploadThing project
  ids carry it.
- A path placeholder may carry an `allowed` list; without one it accepts any
  reference segment in the reference grammar below.
- Literal hostname labels and path segments use unreserved characters only:
  `[A-Za-z0-9._~-]`. A literal path segment is never `.` or `..`.
- `placeholders` names exactly the placeholders in `url`; an entry for a name
  that is not in the URL, or a missing entry, is rejected.

## S3

```json
{
  "id": "media",
  "type": "s3",
  "endpoint": "https://account.r2.cloudflarestorage.com",
  "region": "auto",
  "bucket": "ernesta-images",
  "pathStyle": true,
  "keyTemplate": "{key}"
}
```

- `endpoint` is an `https:` origin with no path, credentials, query, or
  fragment. `bucket` is an S3 bucket name. `region` is any non-empty string.
- `keyTemplate` is an object key with `{name}` placeholders, each one whole
  `/`-separated segment, following the template rules above; it has at least
  one placeholder and no hostname.
- The fetch location is `{endpoint}/{bucket}/{key}` when `pathStyle` is true,
  otherwise `https://{bucket}.{endpoint host}/{key}`, presigned by Control with
  the resolver's read-only credential. The credential is stored beside the
  resolver in Control, sealed with the registry encryption key, and is never
  part of the Space policy, an Edge snapshot, or a log.

## Reference grammar

A reference segment, after one percent-decoding, matches
`[A-Za-z0-9._-]{1,512}` and is never `.` or `..`. When the placeholder has an
`allowed` list the segment must also be one of those values. Segments are
substituted with `encodeURIComponent` and no other transformation.

## Allowlist

Every fetch location a resolver can produce must pass the Space's
`allowedSourceOrigins` under the v1 locator rules. The policy parser proves
this once at save time: for each allowed value of a hostname placeholder it
checks the literal path before the first path placeholder against the
allowlist, so a rule must cover that prefix, not a value inside it. A reference
segment never contains `/`, so no expansion can leave a covered prefix. The Edge
and Control re-check the expanded location before every fetch.

## Source identity

The Source ID of a resolver source is the resolver ID, a `/`, and the decoded
reference segments joined by `/`: `ut/ernesta_prod/file_9`, `media/AbC123`.
The resolver ID is immutable and part of identity. Removing a resolver orphans
its cached bytes and stored Master Previews. Source Purge removes both; the
thirty-day lifecycle rule (ADR 0020) removes only the cached bytes, never a
Master Preview.

## Where resolution happens

| Operation | Template | S3 |
| --- | --- | --- |
| Image Optimization miss | Edge validates the reference; Control expands | Control presigns for imgproxy |
| Source Delivery miss | Edge expands from its snapshot | Edge asks Control (`POST /internal/v2/resolve`) for a 10-minute presigned URL |
| Preview Job attempt | Control expands at claim | Control presigns at claim for the attempt lease |
