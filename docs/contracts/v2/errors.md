# V2 errors

Every v2 JSON endpoint on Control answers request errors with RFC 9457 Problem
Details:

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json
Cache-Control: private, no-store
X-Request-Id: 01J...

{
  "type": "https://shutter.traydr.dev/problems/not_found",
  "title": "Not Found",
  "status": 404,
  "code": "not_found",
  "requestId": "01J..."
}
```

`code` is the stable machine-readable member and the only one clients branch
on; `type` is `https://shutter.traydr.dev/problems/{code}`. `title` is the
HTTP reason phrase. `requestId` matches the `X-Request-Id` header so an
operator can find the redacted log event.

The v2 codes are the v1 codes with the same status policy: `unauthorized`
(401), `not_found` (404), `request_invalid` (400), `service_unavailable` (503),
`optimization_failed` (502). A problem never contains a locator, capability,
token, Source ID, upstream response, or error message.

Delivery routes on the Edge are unchanged: they answer with status codes and
`cache-control` only, as the v1 delivery contract describes. The v1 JSON
endpoints keep `{ "error": { "code" } }`.
