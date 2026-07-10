# V1 Rendition Policy

## Canonical widths

```ts
export const SHUTTER_WIDTHS = [
  320,
  640,
  750,
  828,
  960,
  1080,
  1280,
  1668,
  1920,
  2048,
  2560,
  3200,
  3840,
] as const;
```

Requested width normalizes to the smallest canonical width greater than or
equal to it. Requests above 3840 normalize to 3840. imgproxy uses
`without_enlargement`, so an input smaller than the target retains its original
dimensions. Unpic's 24px automatic background is a separate placeholder request
and does not join the responsive `srcset` ladder.

Consumers pass `SHUTTER_WIDTHS` explicitly to Unpic; they do not rely on
package-default breakpoint generation.

## Quality

| Space | Permitted | Default |
| --- | --- | --- |
| Ernesta | `30`, `50`, `75` | `75` |
| Pane View | `30`, `75`, `80` | `75` |

Unsupported quality values normalize to the nearest permitted value. Equal
distance resolves upward. Master Preview materialization is fixed at quality
`90` and is not a caller-selected Image Optimization quality.

## Fixed behavior

- Output format is WebP.
- Width is the only size transform and preserves the source aspect ratio.
- Unpic height remains browser layout metadata and is omitted from Shutter URLs.
- Cropping, enlargement, filters, watermarks, arbitrary source URLs, and
  caller-selected formats are rejected.

## Delivery lifetime

- Private image Source Capability: 24 hours.
- Public browser cache: 1 day.
- Public Cloudflare edge cache: 30 days.
- R2 optimized-image cache: 30 days after object creation.
- Public UploadThing resolver: no Source Capability.
- Public presigned locator: capability excluded from the CDN cache key, so a
  renewed locator reuses the existing public rendition.
