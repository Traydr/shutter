import { readFile } from "node:fs/promises";

const lifecycle = JSON.parse(
  await readFile(new URL("../infra/cloudflare/r2-lifecycle.json", import.meta.url), "utf8"),
);
const expectedRule = lifecycle.rules?.[0];
if (
  lifecycle.rules?.length !== 1 ||
  expectedRule?.enabled !== true ||
  expectedRule?.conditions?.prefix !== "cache/" ||
  expectedRule?.deleteObjectsTransition?.condition?.type !== "Age" ||
  expectedRule?.deleteObjectsTransition?.condition?.maxAge !== 2_592_000
) {
  throw new Error("R2 lifecycle must expire only cache/ objects after exactly 30 days");
}

const wrangler = await readFile(new URL("../apps/edge/wrangler.jsonc", import.meta.url), "utf8");
if (!wrangler.includes('"binding": "RENDITION_STORE"')) {
  throw new Error("Worker must bind the Rendition Store natively");
}
if (
  !wrangler.includes('"pattern": "shutter-edge.traydr.dev"') ||
  !wrangler.includes('"custom_domain": true')
) {
  throw new Error("Worker must retain the reviewed shutter-edge.traydr.dev custom domain");
}
if (wrangler.includes("nodejs_compat")) {
  throw new Error("Worker must not enable nodejs_compat");
}

const railway = await readFile(new URL("../.railway/railway.ts", import.meta.url), "utf8");
if (!railway.includes("ghcr.io/imgproxy/imgproxy:v4.0.3")) {
  throw new Error("Railway must pin the reviewed imgproxy image version");
}
// The source allowlist is deployment-specific and set outside the repo, so the
// only thing this can enforce is that nobody hardcodes one back in. A committed
// literal would otherwise silently widen what imgproxy is willing to fetch.
if (!/IMGPROXY_ALLOWED_SOURCES:\s*preserve\(\)/u.test(railway)) {
  throw new Error("imgproxy source allowlist must stay a preserved deployment value");
}
for (const guard of [
  "IMGPROXY_ALLOW_LINK_LOCAL_SOURCE_ADDRESSES",
  "IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES",
  "IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES",
  "IMGPROXY_ALLOW_SECURITY_OPTIONS",
]) {
  if (!railway.includes(`${guard}: "false"`)) {
    throw new Error(`imgproxy must keep ${guard} disabled`);
  }
}
