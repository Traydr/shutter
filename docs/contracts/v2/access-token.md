# V2 Access Token

## Envelope

```text
v2.<kid>.<iv>.<ciphertext-and-tag>
```

The v1 Source Capability envelope at version `v2`: unpadded base64url
components, `kid` selecting an active Capability Key of the Space, a fresh
96-bit AES-GCM nonce, and authenticated ciphertext. Version, Space, key ID, and
purpose are authenticated as associated data. The same Capability Key issues
and verifies both v1 capabilities and v2 tokens.

## Claims

```ts
type AccessTokenClaims = {
  space_id: string;
  source_id: string; // "{resolver}/{reference}"
  purpose: "source_delivery" | "image_source" | "master_preview";
  kind?: "video" | "pdf"; // present exactly for master_preview
  iat: number;
  exp: number;
};
```

Times are integer Unix seconds; the lifetime is at most 24 hours. There is no
locator claim and a token carrying one is rejected.

## Use

A private Space's v2 Delivery URL carries the token as `token`. The Worker
validates it before any cache lookup, including warm hits, and requires:

| Query selects | Required purpose | Kind |
| --- | --- | --- |
| Source Delivery | `source_delivery` | absent |
| Image Optimization | `image_source` | absent |
| Master Preview | `master_preview` | equals `preview` |

`source_id` must equal the Source ID the resolver and reference name. A
mismatch of Space, purpose, Source ID, or kind, an expired or future token, an
unknown key, or a tampered envelope answers `403` with `private, no-store`. The
token never enters cache identity, so a fresh token reuses cached bytes.
Private responses stay `private, no-store` and never redirect to a canonical
query. Because the purpose is authenticated, a token minted for one operation
cannot be reused for another by editing the query: an application mints each
private URL for the operation and width it will be requested at, and a
transformer that changes the operation must drop the token.
