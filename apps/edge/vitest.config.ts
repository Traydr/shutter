import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CAPABILITY_KEYS:
            '{"ernesta":{"fixture-key-2026-07":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},"pane-view":{"fixture-key-2026-07":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}',
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
