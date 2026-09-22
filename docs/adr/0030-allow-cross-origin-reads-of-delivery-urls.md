# Allow cross-origin reads of Delivery URLs

Every response on a v1 or v2 delivery route carries
`Access-Control-Allow-Origin: *` and never `Access-Control-Allow-Credentials`.
A preflight on those routes answers `204` allowing `GET` and `HEAD` with the
`Range`, `If-Range`, `If-None-Match`, and `If-Modified-Since` request headers,
cacheable by the browser for one day. Responses expose `Accept-Ranges`,
`Content-Length`, `Content-Range`, `ETag`, and `Last-Modified`. The
`/internal/` routes are outside the rule.

A Delivery URL is its own authorization: a public URL names a public source, a
private one carries the Access Token, and the Edge reads no cookie. CORS exists
to stop a page from reading a response the browser could reach only with the
user's ambient credentials, and no such response exists here, so reflecting or
allowlisting origins would add per-Space configuration without adding a
guarantee. Without the header, a consumer can embed a Delivery URL in `<img>`
and `<video>` but cannot read it with `fetch`, which is what a range-driven PDF
viewer such as pdf.js does. Pane View's PDF viewer already depends on the
Railway bucket answering `*`; moving originals from presigned bucket URLs to
Source Delivery must not lose that. Errors carry the header too, so a `fetch`
caller sees a `403` or `404` rather than an opaque network error.
