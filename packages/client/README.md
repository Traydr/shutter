# @shutter/client

Server-side client for consuming applications. It wraps every v1 endpoint an
application calls: capability issuance, delivery URL construction, Preview
Jobs, and Source Purge. It depends only on `@shutter/protocol` and Web
standards (`fetch`, WebCrypto), so it runs in Node 22+, workers, and Next.js
server runtimes.

Keep it server-side. The Capability Key and Space API token must never reach a
browser. The one exception is the `@shutter/client/urls` subpath, which holds
no crypto and no credentials and is meant for browser bundles.

```ts
import { createShutterClient } from "@shutter/client";

const shutter = createShutterClient({
  spaceId: "my-space",
  controlBaseUrl: process.env.SHUTTER_CONTROL_URL,
  edgeBaseUrl: process.env.SHUTTER_EDGE_URL,
  spaceApiToken: process.env.SHUTTER_SPACE_API_TOKEN,
  capabilityKey: {
    kid: process.env.SHUTTER_CAPABILITY_KID,
    key: process.env.SHUTTER_CAPABILITY_KEY, // base64url
  },
});

// After your own authorization check for this user and media record:
const src = await shutter.privateSourceUrl(
  { sourceId: media.sha256, locator: presignedGetUrl },
  { width: 1200, quality: 75 },
);

// Materialize a video poster or PDF cover, then link its thumbnail:
const job = await shutter.waitForPreviewJob({
  sourceId: media.sha256,
  kind: "video",
  locator: presignedGetUrl,
});
if (job.status === "ready") {
  const poster = await shutter.privateMasterUrl(
    { sourceId: media.sha256, kind: job.master.kind },
    { width: 640, quality: 75 },
  );
}

// After deleting the original:
await shutter.purgeSource(media.sha256);
```

`submitPreviewJob` and `getPreviewJob` expose single calls when you manage
polling yourself; both return the same discriminated `PreviewJobResult`.
Failed jobs come back as `status: "failed"` with the contract's failure code
and action, not as exceptions. Exceptions (`ShutterClientError` with `status`
and `code`) are reserved for transport and authentication problems.

Every method that needs configuration you did not provide throws immediately
with the missing field's name, matching Shutter's fail-closed convention.

Every URL helper snaps the width to Shutter's canonical ladder (`320, 640, 750,
828, 960, 1080, 1280, 1668, 1920, 2048, 2560, 3200, 3840`, with Unpic's `24`
placeholder kept exact), so `{ width: 1200 }` comes out as `w=1280`.
`canonicalWidth` exposes the rule and throws a `TypeError` for anything but a
positive integer. Quality is the Space's policy, which the client cannot see:
pass a permitted value, or a public route answers with a one-time
canonicalization redirect.

## v2: resolver sources

A public Space with a Source Resolver needs no capability at all. The browser
builds the Delivery URL from the resolver and the application's own key, and
the server side submits jobs and purges with the Space API token alone.

```ts
// Browser or server: no crypto in this entry point.
import { deliveryUrl, transformDeliveryUrl } from "@shutter/client/urls";

const src = deliveryUrl(
  { edgeBaseUrl: "https://shutter-edge.example", spaceId: "my-space", resolverId: "media", reference: key },
  { width: 640, quality: 75 },
);
// Unpic-style transformer for a v2 URL; 1000 snaps to w=1080:
transformDeliveryUrl(src, "https://shutter-edge.example", { width: 1000, quality: 75 });

// Server: jobs and purge by resolver source.
const job = await shutter.waitForV2PreviewJob({ resolverId: "media", reference: key, kind: "video" });
if (job.status === "ready") {
  const poster = shutter.v2DeliveryUrl(
    { resolverId: "media", reference: key },
    { preview: "video", width: 640, quality: 75 },
  );
}
await shutter.purgeV2Source({ resolverId: "media", reference: key });
```

`reference` is one value per placeholder of the resolver (a string for a
one-placeholder resolver, an array otherwise) and must fit the reference
grammar; the builders throw a `TypeError` otherwise, as they do for a resolver
ID outside the identifier grammar. `transformDeliveryUrl` accepts the relative
path `deliveryUrl` returns without an `edgeBaseUrl` and hands a relative path
back. It snaps the width like every other helper, so the 1x and 2x widths
Unpic asks for (500 and 1000 for a 500px component) become `w=640` and
`w=1080` rather than redirects. An off-ladder width would otherwise cost an
uncacheable `308`, a second round trip, and a second Worker request per image.
Give it the quality as well as the width: on a public Space a `w` without `q`
is canonicalized with a one-time 308, and the browser-safe entry cannot know
the Space's default. v2 request errors arrive as RFC 9457 problems;
`ShutterClientError.code` carries their `code` and `requestId` the handle an
operator finds the log event by.

For a private Space the same URLs carry an access token minted with the
Capability Key; the purpose follows the options you pass, so the three grants
cannot be confused:

```ts
const src = await shutter.v2PrivateDeliveryUrl(
  { resolverId: "media", reference: key },
  { width: 640, quality: 75 },
);
```

A token is bound to the operation it was minted for, so mint private URLs
with the width they are shown at. `transformDeliveryUrl` keeps the token only
while the operation stays the same; widening a Source Delivery URL drops it,
and the Edge refuses the result until the application mints an `image_source`
token.
