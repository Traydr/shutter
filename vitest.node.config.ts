import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/{control,executor-video,executor-pdf}/src/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
    ],
  },
});
