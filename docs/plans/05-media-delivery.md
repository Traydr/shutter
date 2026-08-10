# Plan 05 — Media delivery through one hostname

One later PR, after plans 01 through 03. Extend Shutter from a rendition-only
system into a media delivery front door, while keeping image optimization as an
optional path.

## Goal

Applications use one Shutter hostname for supported media:

- original images can pass through unchanged or use Image Optimization;
- videos can pass through with range requests;
- PDFs can pass through unchanged; and
- existing video posters and PDF covers remain Master Previews.

This is a Bunny-style pull model for application-owned media. It is not a media
catalog and does not move upload ownership into Shutter.

## Domain rule

Call unchanged pass-through **Source Delivery**. It delivers Source Object bytes
without converting them. Source ID remains the cache and purge identity. Source
Locator remains only the current fetch path.

## Steps

### 1. Add a versioned Source Delivery contract

Add explicit public and private source-delivery routes under `/v1`. Support only
`GET` and `HEAD`. Reject unsupported methods and transformation query parameters.

Private delivery requires a new `source_delivery` Source Capability purpose.
Do not reuse `image_source`, because one capability must authorize one purpose.
Public delivery still uses trusted Space resolvers or a capability-bound located
source; never accept an arbitrary unsigned URL.

### 2. Preserve media HTTP behavior

Pass through allowlisted media response metadata. Define a strict allowlist for
content types and response headers. Support byte ranges and conditional requests
needed by video and PDF clients. Preserve correct `206`, `Content-Range`,
`Accept-Ranges`, `ETag`, and `Last-Modified` behavior when the trusted origin
provides them.

Reject HTML, scripts, archives, and active content until a later protocol
version allows them. Add download-safety headers where inline rendering is not
intended.

### 3. Define cache identity and privacy

Build public cache identity from Space ID and immutable Source ID, never from a
presigned locator. Check private capability authorization before every cache
lookup. Define whether full objects and range segments use Cloudflare cache,
R2, or direct origin fetch after testing large video behavior.

Do not copy authoritative originals into the Rendition Store in the first
version. Shutter remains a delivery and rendition layer over
application-owned storage.

### 4. Keep Image Optimization optional

Source Delivery and Image Optimization are sibling routes. An image can use
either route without changing its Source ID. Videos and PDFs use Source
Delivery, while their responsive posters and covers continue to use Master
Preview plus Image Optimization.

### 5. Extend purge and observability

Source Purge must clear cached Source Delivery bytes in addition to Renditions
and Master Previews. Keep logging allowlisted and redacted; do not log locators,
capabilities, raw paths, range values, or Source IDs.

Measure cache result, media class, route class, byte-range outcome, and origin
fetch result with bounded fields.

## Verification

Test small and large images, video seeking, PDF viewing, `GET`, `HEAD`, ranges,
conditional requests, cache hits, private authorization before cache, locator
rotation with stable Source ID, and repeated Source Purge.

## Deferred choices inside this plan

Run a focused prototype before choosing range-cache storage and maximum object
size. These choices affect cost and video-seek behavior and should use measured
Cloudflare behavior rather than an assumption.
