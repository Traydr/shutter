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
for (const source of [
  "https://8w0z32yftd.ufs.sh/f/",
  "https://rrsku8h9ue.ufs.sh/f/",
  "https://t3.storageapi.dev/balanced-wrap-ocyiwwexhao/",
]) {
  if (!railway.includes(source)) {
    throw new Error(`imgproxy must retain reviewed source prefix ${source}`);
  }
}
if (railway.includes("https://pane-view.traydr.dev/")) {
  throw new Error("imgproxy must not allow the Pane View app host as a source origin");
}
