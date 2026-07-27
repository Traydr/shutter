import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CAPABILITY_KEYS:
            '{"demo-public":{"fixture-key-2026-07":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},"demo-private":{"fixture-key-2026-07":"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"}}',
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
