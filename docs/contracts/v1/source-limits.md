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
| Video | 512 MiB | Unsupported/corrupt stream or no decodable frame |
| PDF | 128 MiB | Corrupt, zero-page, or password-protected document |

Type ceilings are global v1 security policy, not caller-controlled job options.
