# imgproxy deployment

Railway runs the pinned `ghcr.io/imgproxy/imgproxy:v4.0.3` image on its private
network. The deployment is declared in `.railway/railway.ts` and intentionally
has no public domain.

`IMGPROXY_KEY`, `IMGPROXY_SALT`, and `IMGPROXY_SECRET` are preserved Railway
secrets. Control receives references to the same values so it can sign every
processing path and attach the bearer credential. imgproxy independently checks
both controls.

The checked-in source allowlist is the deliberately unreachable
`https://invalid.shutter.invalid/`. Replace it only with reviewed HTTPS prefixes
that correspond to the deployed Space policies. A blank value is forbidden
because imgproxy interprets it as allowing every source URL.

The remaining environment values lock the v1 source ceilings: 128 MiB, 50
megapixels, first animation frame only, two redirects, 30-second download, and
3840-pixel output. Loopback, link-local, private-address sources, TLS bypass,
and per-request security overrides remain disabled.
