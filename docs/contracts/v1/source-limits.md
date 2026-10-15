# V1 source limits

## Image Optimization

- Maximum source bytes: 128 MiB.
- Maximum decoded source resolution: 50 megapixels.
- Animated image frames: first frame only.
- Source download timeout: 30 seconds.
- Maximum source redirects: 2.
- Maximum result dimension: 3840 pixels.

imgproxy processing URLs cannot override security limits. Production disables
loopback, link-local, and private source addresses, permits only configured HTTPS
origin prefixes, retains PNG/SVG safety limits, and never ignores TLS
verification.

imgproxy is reachable only from Shutter's Railway services. Requests require an
internal bearer credential and an HMAC-signed imgproxy processing path. Raw,
unsigned, and caller-constructed imgproxy URLs are rejected.

## Master Preview sources

| Kind | Maximum bytes | Other terminal checks |
| --- | ---: | --- |
| Video | 512 MiB | Unsupported/corrupt stream, a frame over 8K (33,177,600 pixels), or no decodable frame |
| PDF | 128 MiB | Corrupt or zero-page document, a document that needs a user password to open, or a page one that renders at the wrong size |

- Source idle timeout: 30 seconds without response headers or body bytes.
- Source throughput floor: once 30 seconds of waiting are spent, a read whose
  average falls below 1 MiB/s is abandoned. Both are retryable.
- Maximum source redirects: 2, each hop checked against the allowed source
  origins.
- Video containers: MP4/MOV, Matroska/WebM, AVI, MPEG-TS, FLV, Ogg, ASF, and
  MPEG-PS. Playlists, concat lists, and image sequences are refused.
- A video's size limit is read from the origin's `Content-Range` total when the
  origin honors `Range`, so an oversized video fails before it is read.
- Once its size is known, a video read through `Range` asks the origin for at
  most that size plus 16 MiB, in at most 256 more requests counting redirect
  hops. Past either, or when the origin stops honoring `Range`, the video is
  downloaded whole instead.
- A PDF with only an owner password renders normally.
- Master Preview output: the longest edge is at most 1920 pixels, the aspect
  ratio is kept, and nothing is enlarged. A PDF renders at 150 DPI, lowered
  when that would exceed 1920 pixels.

Type ceilings are global v1 security policy, not caller-controlled job options.
