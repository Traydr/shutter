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

type Environment = Record<string, string | undefined>;

interface WranglerConfig {
  account_id?: string;
  name?: string;
  routes?: unknown;
  r2_buckets?: unknown;
  [key: string]: unknown;
}

interface CurrentEnvironment {
  projectId?: string;
  environmentId?: string;
  projectName?: string;
  environmentName?: string;
}

export async function loadDeploymentEnvironment(): Promise<Environment> {
  const source = await readFile(inputPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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

export function createEdgeDeploymentConfig(
  base: WranglerConfig,
  environment: Environment,
): WranglerConfig {
  const input = parseDeploymentInput(environment);
  return {
    ...base,
    account_id: input.cloudflareAccountId,
    name: input.edgeWorkerName,
    routes: [{ pattern: input.edgeDomain, custom_domain: true }],
    r2_buckets: [{ binding: "MEDIA_STORE", bucket_name: input.r2Bucket }],
  };
}

async function currentRailwayTarget(environment: Environment): Promise<CurrentEnvironment> {
  const { stdout } = await execFile("pnpm", ["exec", "railway", "config", "plan", "--json"], {
    cwd: root,
    env: { ...process.env, ...environment },
    maxBuffer: 2_000_000,
  });
  const result = JSON.parse(stdout) as { ok?: boolean; currentEnvironment?: CurrentEnvironment };
  if (!result.ok || !result.currentEnvironment) {
    throw new Error("Railway did not return a linked plan target");
  }
  return result.currentEnvironment;
}

async function assertRailwayTarget(environment: Environment): Promise<void> {
  const expected = parseRailwayTarget(environment);
  const current = await currentRailwayTarget(environment);
  if (
    current.projectId !== expected.projectId ||
    current.environmentId !== expected.environmentId
  ) {
    throw new Error("The linked Railway project or environment changed; refusing to continue");
  }
}

async function updateDeploymentInput(updates: Record<string, string>): Promise<void> {
  const source = await readFile(inputPath, "utf8");
  const retained = source
    .split(/\r?\n/u)
    .filter((line) => !Object.keys(updates).some((key) => line.startsWith(`${key}=`)))
    .filter((line, index, lines) => line || index < lines.length - 1);
  const next = [...retained, ...Object.entries(updates).map(([key, value]) => `${key}=${value}`)];
  await writeFile(inputPath, `${next.join("\n")}\n`, { mode: 0o600 });
}

async function bindRailwayTarget(environment: Environment): Promise<void> {
  const input = parseDeploymentInput(environment);
  const current = await currentRailwayTarget(environment);
  if (current.projectName !== input.projectName) {
    throw new Error(
      `Linked Railway project is ${current.projectName}, expected ${input.projectName}`,
    );
  }
  if (!current.projectId || !current.environmentId) {
    throw new Error("Railway did not report the linked project and environment IDs");
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
  await updateDeploymentInput({
    SHUTTER_RAILWAY_PROJECT_ID: current.projectId,
    SHUTTER_RAILWAY_ENVIRONMENT_ID: current.environmentId,
  });
  console.log(
    `Bound Railway project ${current.projectName} (${current.projectId}), ` +
      `environment ${current.environmentName} (${current.environmentId}).`,
  );
}

interface RailwayVolume {
  name?: string;
  serviceName?: string;
  deletedAt?: string | null;
  isPendingDeletion?: boolean;
}

async function liveJobsVolumeName(environment: Environment): Promise<string | undefined> {
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
  const result = JSON.parse(stdout) as { volumes?: RailwayVolume[] };
  const volumes = (result.volumes ?? []).filter(
    (volume) =>
      volume.serviceName === "Shutter-Jobs" &&
      volume.deletedAt === null &&
      volume.isPendingDeletion === false,
  );
  if (volumes.length === 0) return undefined;
  if (volumes.length !== 1 || !volumes[0].name) {
    throw new Error("Expected exactly one active Jobs volume");
  }
  return volumes[0].name;
}

/**
 * Records the live Jobs volume name so the desired graph declares it. The name
 * always comes from Railway itself, never from operator typing, so the graph
 * can never contain a volume that differs from the database's real storage.
 */
async function discoverJobsVolume(environment: Environment): Promise<void> {
  const live = await liveJobsVolumeName(environment);
  if (live === undefined) {
    console.log("No provisioned Jobs volume was found.");
    return;
  }
  const recorded = environment.SHUTTER_JOBS_VOLUME_NAME?.trim();
  if (recorded && recorded !== live) {
    throw new Error(
      `Recorded Jobs volume ${recorded} does not match the live volume ${live}; ` +
        "refusing to continue",
    );
  }
  if (recorded === live) return;
  await updateDeploymentInput({ SHUTTER_JOBS_VOLUME_NAME: live });
  environment.SHUTTER_JOBS_VOLUME_NAME = live;
  console.log(`Recorded Jobs volume ${live}.`);
}

async function controlHasLiveCredentials(environment: Environment): Promise<boolean> {
  const target = parseRailwayTarget(environment);
  try {
    const { stdout } = await execFile(
      "pnpm",
      [
        "exec",
        "railway",
        "variable",
        "list",
        "--service",
        "Shutter-Control",
        "--project",
        target.projectId,
        "--environment",
        target.environmentId,
        "--kv",
      ],
      { cwd: root, env: process.env, maxBuffer: 2_000_000 },
    );
    return stdout.split(/\r?\n/u).some((line) => line.startsWith("EDGE_CONFIG_TOKEN="));
  } catch {
    // No service yet: nothing live to protect.
    return false;
  }
}

export async function renderEdgeDeploymentConfig(environment: Environment): Promise<string> {
  const base = JSON.parse(await readFile(baseWranglerPath, "utf8")) as WranglerConfig;
  const deployed = createEdgeDeploymentConfig(base, environment);
  await writeFile(deployedWranglerPath, `${JSON.stringify(deployed, null, 2)}\n`, {
    mode: 0o600,
  });
  return deployedWranglerPath;
}

async function runRailway(action: "plan" | "apply", environment: Environment): Promise<void> {
  const input = parseDeploymentInput(environment);
  await assertRailwayTarget(environment);
  // Close the two windows where a plan could propose destruction: a live Jobs
  // volume that the input does not declare yet, and live credentials that the
  // input does not preserve yet.
  const state = parseBootstrapState(environment);
  if (state.phase === "linked") await discoverJobsVolume(environment);
  if (
    action === "apply" &&
    !input.secretsSeeded &&
    (await controlHasLiveCredentials(environment))
  ) {
    throw new Error(
      "Live credentials exist on Shutter-Control but SHUTTER_SECRETS_SEEDED is not true. " +
        "Run the wizard credential stage (or set SHUTTER_SECRETS_SEEDED=true) before applying.",
    );
  }
  const child = spawn("pnpm", ["exec", "railway", "config", action], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveStatus, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveStatus({ code, signal }));
    },
  );
  if (status.signal) throw new Error(`Railway config ${action} ended with ${status.signal}`);
  if (status.code !== 0) process.exitCode = status.code ?? 1;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (
    command === undefined ||
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
      "Usage: node scripts/deployment-config.ts render-edge|bind-target|assert-target|bootstrap-phase|cloudflare-phase|discover-volume|plan|apply",
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
  await runRailway(command === "apply" ? "apply" : "plan", environment);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
