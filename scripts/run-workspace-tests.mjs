import { spawnSync } from "node:child_process";

// Cloudflare Workers Builds sets WORKERS_CI=1 and has no Docker/cgroup support
// for Postgres testcontainers. Skip Node tests there; keep the full gate locally.
const skipNodeTests = process.env.WORKERS_CI === "1";
const steps = skipNodeTests
  ? [["pnpm", ["test:worker"]]]
  : [
      ["pnpm", ["test:node"]],
      ["pnpm", ["test:worker"]],
    ];

if (skipNodeTests) {
  console.log("WORKERS_CI=1: skipping Docker-backed pnpm test:node");
}

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true });
  if (result.status) process.exit(result.status ?? 1);
}
