import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          EDGE_CONFIG_TOKEN: "test-config-token-that-is-at-least-32-bytes",
          ORIGIN_AUTH_TOKEN: "test-origin-token-that-is-at-least-32-bytes",
          ORIGIN_BASE_URL: "https://origin.shutter.test",
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.worker.test.ts"],
  },
});
