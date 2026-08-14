# @shutter/client

Server-side client for consuming applications. It wraps every v1 endpoint an
application calls: capability issuance, delivery URL construction, Preview
Jobs, and Source Purge. It depends only on `@shutter/protocol` and Web
standards (`fetch`, WebCrypto), so it runs in Node 22+, workers, and Next.js
server runtimes.

Keep it server-side. The Capability Key and Space API token must never reach a
browser.

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
Widths and qualities are normalized server-side by Space policy; pick values
from your Optimization Policy to avoid the one-time canonicalization redirect
on public routes.
