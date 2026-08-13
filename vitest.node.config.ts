import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "services",
          globalSetup: ["./apps/control/src/postgres-test-global.ts"],
          include: [
            "apps/control/src/**/*.test.ts",
            "apps/executor-video/src/**/*.test.ts",
            "apps/executor-pdf/src/**/*.test.ts",
            "packages/*/src/**/*.test.ts",
          ],
        },
      },
      {
        // The deployment-configuration guard runs with no container runtime so
        // it stays in the always-run tier on every machine.
        test: {
          name: "deployment",
          include: ["test/**/*.test.ts"],
        },
      },
    ],
  },
});
