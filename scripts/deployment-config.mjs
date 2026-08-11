import { execFile as execFileCallback, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  parseBootstrapState,
  parseCloudflareBootstrapState,
  parseDeploymentEnvFile,
  parseDeploymentInput,
  parseRailwayTarget,
} from "../.railway/deployment-input.ts";

const execFile = promisify(execFileCallback);

const root = resolve(import.meta.dirname, "..");
const inputPath = resolve(root, ".railway/deployment.env");
const baseWranglerPath = resolve(root, "apps/edge/wrangler.jsonc");
const deployedWranglerPath = resolve(root, "apps/edge/wrangler.deploy.jsonc");

export async function loadDeploymentEnvironment() {
  const source = await readFile(inputPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(
        "Missing .railway/deployment.env. Run scripts/bootstrap-deployment.sh first.",
      );
    }
    throw error;
  });
  const environment = parseDeploymentEnvFile(source);
  parseCloudflareBootstrapState(environment);
  return environment;
}

export function createEdgeDeploymentConfig(base, environment) {
  const input = parseDeploymentInput(environment);
  return {
    ...base,
    account_id: input.cloudflareAccountId,
    name: input.edgeWorkerName,
    routes: [{ pattern: input.edgeDomain, custom_domain: true }],
    r2_buckets: [{ binding: "RENDITION_STORE", bucket_name: input.r2Bucket }],
  };
}

async function currentRailwayTarget(environment) {
  const { stdout } = await execFile("pnpm", ["exec", "railway", "config", "plan", "--json"], {
    cwd: root,
    env: { ...process.env, ...environment },
    maxBuffer: 2_000_000,
  });
  const result = JSON.parse(stdout);
  if (!result.ok || !result.currentEnvironment) {
    throw new Error("Railway did not return a linked plan target");
  }
  return result.currentEnvironment;
}

async function assertRailwayTarget(environment) {
  const expected = parseRailwayTarget(environment);
  const current = await currentRailwayTarget(environment);
  if (
    current.projectId !== expected.projectId ||
    current.environmentId !== expected.environmentId
  ) {
    throw new Error("The linked Railway project or environment changed; refusing to continue");
  }
}

async function updateDeploymentInput(updates) {
  const source = await readFile(inputPath, "utf8");
  const retained = source
    .split(/\r?\n/u)
    .filter((line) => !Object.keys(updates).some((key) => line.startsWith(`${key}=`)))
    .filter((line, index, lines) => line || index < lines.length - 1);
  const next = [...retained, ...Object.entries(updates).map(([key, value]) => `${key}=${value}`)];
  await writeFile(inputPath, `${next.join("\n")}\n`, { mode: 0o600 });
}

async function bindRailwayTarget(environment) {
  const input = parseDeploymentInput(environment);
  const current = await currentRailwayTarget(environment);
  if (current.projectName !== input.projectName) {
    throw new Error(
      `Linked Railway project is ${current.projectName}, expected ${input.projectName}`,
    );
  }
  const hasExpectedTarget =
    environment.SHUTTER_RAILWAY_PROJECT_ID || environment.SHUTTER_RAILWAY_ENVIRONMENT_ID;
  if (hasExpectedTarget) {
    const expected = parseRailwayTarget(environment);
    if (
      current.projectId !== expected.projectId ||
      current.environmentId !== expected.environmentId
    ) {
      throw new Error("Refusing to replace the deployment's recorded Railway target");
    }
  }
  const updates = {
    SHUTTER_RAILWAY_PROJECT_ID: current.projectId,
    SHUTTER_RAILWAY_ENVIRONMENT_ID: current.environmentId,
  };
  await updateDeploymentInput(updates);
  console.log(
    `Bound Railway project ${current.projectName} (${current.projectId}), ` +
      `environment ${current.environmentName} (${current.environmentId}).`,
  );
}

async function discoverJobsVolume(environment) {
  const input = parseDeploymentInput(environment);
  if (input.mode !== "fresh") throw new Error("Volume discovery is only for a fresh bootstrap");
  const target = parseRailwayTarget(environment);
  const { stdout } = await execFile(
    "pnpm",
    [
      "exec",
      "railway",
      "volume",
      "--project",
      target.projectId,
      "--environment",
      target.environmentId,
      "list",
      "--json",
    ],
    { cwd: root, env: process.env, maxBuffer: 1_000_000 },
  );
  const result = JSON.parse(stdout);
  const volumes = result.volumes?.filter(
    (volume) =>
      volume.serviceName === "Shutter-Jobs" &&
      volume.deletedAt === null &&
      volume.isPendingDeletion === false,
  );
  if (!volumes || volumes.length === 0) {
    console.log("No provisioned Jobs volume was found.");
    return;
  }
  if (volumes.length !== 1 || !volumes[0].name) {
    throw new Error("Expected exactly one active Jobs volume");
  }
  await updateDeploymentInput({ SHUTTER_JOBS_VOLUME_NAME: volumes[0].name });
  console.log(`Recorded Jobs volume ${volumes[0].name}.`);
}

export async function renderEdgeDeploymentConfig(environment) {
  const base = JSON.parse(await readFile(baseWranglerPath, "utf8"));
  const deployed = createEdgeDeploymentConfig(base, environment);
  await writeFile(deployedWranglerPath, `${JSON.stringify(deployed, null, 2)}\n`, {
    mode: 0o600,
  });
  return deployedWranglerPath;
}

async function runRailway(action, environment) {
  parseDeploymentInput(environment);
  await assertRailwayTarget(environment);
  const child = spawn("pnpm", ["exec", "railway", "config", action], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  const status = await new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveStatus({ code, signal }));
  });
  if (status.signal) throw new Error(`Railway config ${action} ended with ${status.signal}`);
  if (status.code !== 0) process.exitCode = status.code ?? 1;
}

async function main() {
  const command = process.argv[2];
  if (
    !new Set([
      "render-edge",
      "bind-target",
      "assert-target",
      "bootstrap-phase",
      "cloudflare-phase",
      "discover-volume",
      "plan",
      "apply",
    ]).has(command)
  ) {
    throw new Error(
      "Usage: node scripts/deployment-config.mjs render-edge|bind-target|assert-target|bootstrap-phase|cloudflare-phase|discover-volume|plan|apply",
    );
  }
  const environment = await loadDeploymentEnvironment();
  if (command === "render-edge") {
    const path = await renderEdgeDeploymentConfig(environment);
    console.log(`Wrote ${path}`);
    return;
  }
  if (command === "bind-target") {
    await bindRailwayTarget(environment);
    return;
  }
  if (command === "assert-target") {
    await assertRailwayTarget(environment);
    console.log("Verified the linked Railway project and environment.");
    return;
  }
  if (command === "bootstrap-phase") {
    console.log(parseBootstrapState(environment).phase);
    return;
  }
  if (command === "cloudflare-phase") {
    console.log(parseCloudflareBootstrapState(environment).phase);
    return;
  }
  if (command === "discover-volume") {
    await discoverJobsVolume(environment);
    return;
  }
  await runRailway(command, environment);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
