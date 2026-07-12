import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./apps/control/src/postgres-test-global.ts"],
    include: [
      "apps/{control,executor-video,executor-pdf}/src/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
    ],
  },
});
