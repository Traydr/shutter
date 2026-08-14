# V1 Source Capability

## Compact envelope

```text
v1.<kid>.<iv>.<ciphertext-and-tag>
```

Every binary component is unpadded base64url. `kid` selects an active Space
capability key, `iv` is a fresh random 96-bit AES-GCM nonce, and the final
component contains authenticated ciphertext and tag. Version, Space, key ID,
and expected purpose are authenticated as associated data. Implementations must
never reuse an IV with the same key.

## Common claims

```ts
type CommonClaims = {
  space_id: string;
  source_id: string;
  purpose: "image_source" | "source_delivery" | "master_preview" | "preview_job";
  iat: number;
  exp: number;
};
```

Times are integer Unix seconds. A decoder rejects an unknown version or key ID,
authentication failure, expired token, future `iat`, Space mismatch, route
purpose mismatch, and claims outside configured size limits.

## Purpose claims

```ts
type ImageSourceClaims = CommonClaims & {
  purpose: "image_source";
  locator: string;
};

type SourceDeliveryClaims = CommonClaims & {
  purpose: "source_delivery";
  locator: string;
};

type MasterPreviewClaims = CommonClaims & {
  purpose: "master_preview";
  kind: "video" | "pdf";
};

type PreviewJobClaims = CommonClaims & {
  purpose: "preview_job";
  kind: "video" | "pdf";
  locator: string;
};
```

`locator` is an exact HTTPS GET location that must also pass the Space origin
allowlist and global source-safety rules. `master_preview` never contains an
original locator. Derivative width and quality are outside every capability and
are constrained by the Space Derivative Policy.

The four purposes are non-interchangeable. A route validates purpose before
performing a cache lookup, R2 read, job mutation, or source fetch. The sole
exception is the intentionally public located Image Optimization route: it
checks public edge and R2 cache entries first, then decrypts and validates
`image_source` only if it must fetch the application-owned original. Public
located Source Delivery validates `source_delivery` before its cache lookup.
