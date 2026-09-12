/**
 * A Control that serves only the admin API over an in-memory registry, for
 * developing the admin application without Postgres. Nothing here persists;
 * restart and the seed is back.
 *
 *   ADMIN_API_TOKEN=... pnpm --filter @shutter/control dev:admin-api
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createAdminApi } from "./admin-api.js";
import { EdgeRefreshTracker } from "./edge-refresh-status.js";
import { createSourceResolverService } from "./source-resolvers.js";
import { MemorySpaceRegistry } from "./spaces/memory-registry.js";

/** The token the admin app's `.env.example` carries; an `ADMIN_API_TOKEN` in the environment replaces it. */
const DEV_TOKEN = "dev_admin_api_token_0123456789abcdefghijklmnop";
const token = process.env.ADMIN_API_TOKEN ?? DEV_TOKEN;
const tokenSource =
  process.env.ADMIN_API_TOKEN === undefined ? "the dev default" : "ADMIN_API_TOKEN";
const port = Number(process.env.PORT ?? 3200);

const registry = new MemorySpaceRegistry({
  spaces: [
    {
      id: "ernesta",
      routeClass: "public",
      qualities: [60, 75, 90],
      defaultQuality: 75,
      allowedSourceOrigins: [
        { origin: "https://uploads.example.test", pathPrefix: "/f" },
        { origin: "https://objects.example.test", pathPrefix: "/ernesta-images" },
      ],
      resolvers: [
        {
          id: "media",
          type: "template",
          url: "https://uploads.example.test/f/{file}",
          placeholders: { file: {} },
        },
      ],
    },
    {
      id: "pane-view",
      routeClass: "private",
      qualities: [75],
      defaultQuality: 75,
      allowedSourceOrigins: [{ origin: "https://objects.example.test", pathPrefix: "/pane" }],
      resolvers: [],
    },
  ],
});
await registry.issueApiToken("ernesta", "production deploy");
await registry.addCapabilityKey("ernesta", "k-2026-09");
const refresh = new EdgeRefreshTracker();
refresh.report(2);

const app = new Hono();
app.route(
  "/",
  createAdminApi({
    token: () => token,
    registry,
    sourceResolvers: createSourceResolverService({
      credentials: registry,
      presigner: {
        presign: async ({ key }) =>
          `https://objects.example.test/bucket/${key}?X-Amz-Signature=dev`,
      },
    }),
    probeLocation: async () => ({
      status: 206,
      headers: new Headers({ "content-type": "image/jpeg", "content-range": "bytes 0-0/4096" }),
    }),
    addressLookup: async () => ["93.184.216.34"],
    imgproxyAllowedSources: () => "https://uploads.example.test/",
    edgeRefreshStatus: () => refresh.latest(),
    edgeBaseUrl: () => "https://edge.example.test",
  }),
);

serve({ fetch: app.fetch, port }, () => {
  console.log(`admin API dev Control on http://localhost:${port}, token from ${tokenSource}`);
});
