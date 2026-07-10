# imgproxy deployment

Railway runs the pinned `ghcr.io/imgproxy/imgproxy:v4.0.3` image on its private
network. The deployment is declared in `.railway/railway.ts` and intentionally
has no public domain.

`IMGPROXY_KEY`, `IMGPROXY_SALT`, and `IMGPROXY_SECRET` are provisioned directly
in Railway after the initial IaC apply. Once the services exist, the declarative
configuration preserves those Railway-managed values without copying them into
source. Control receives the same values through Railway's secret store so it
can sign every processing path and attach the bearer credential. imgproxy
independently checks both controls.

The two-stage setup works around Railway IaC's current inability to apply
`preserve()` variables while creating a new service. After initial creation,
`preserve()` prevents subsequent configuration plans from deleting or replacing
the Railway-managed values.

The checked-in source allowlist is the deliberately unreachable
`https://invalid.shutter.invalid/`. Replace it only with reviewed HTTPS prefixes
that correspond to the deployed Space policies. A blank value is forbidden
because imgproxy interprets it as allowing every source URL.

The remaining environment values lock the v1 source ceilings: 128 MiB, 50
megapixels, first animation frame only, two redirects, 30-second download, and
3840-pixel output. Loopback, link-local, private-address sources, TLS bypass,
and per-request security overrides remain disabled.
