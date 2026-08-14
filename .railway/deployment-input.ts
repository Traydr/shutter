const publicInputKeys = [
  "SHUTTER_PROJECT_NAME",
  "SHUTTER_GITHUB_REPOSITORY",
  "SHUTTER_RAILWAY_REGION",
  "SHUTTER_CONTROL_DOMAIN",
  "SHUTTER_EDGE_WORKER_NAME",
  "SHUTTER_EDGE_DOMAIN",
  "SHUTTER_R2_BUCKET",
  "SHUTTER_R2_ENDPOINT",
  "SHUTTER_R2_REGION",
  "SHUTTER_CLOUDFLARE_ZONE_ID",
  "SHUTTER_IMGPROXY_ALLOWED_SOURCES",
  "SHUTTER_SECRETS_SEEDED",
  "SHUTTER_JOBS_VOLUME_NAME",
  "SHUTTER_RAILWAY_PROJECT_ID",
  "SHUTTER_RAILWAY_ENVIRONMENT_ID",
  "SHUTTER_R2_READY_ACCOUNT_ID",
  "SHUTTER_R2_READY_BUCKET",
] as const;

type Environment = Record<string, string | undefined>;

interface CommonDeploymentInput {
  projectName: string;
  repository: string;
  railwayRegion: string;
  controlDomain: string;
  edgeWorkerName: string;
  edgeDomain: string;
  r2Bucket: string;
  r2Endpoint: string;
  r2Region: string;
  cloudflareAccountId: string;
  cloudflareZoneId: string;
  imgproxyAllowedSources: string;
}

/**
 * Two independent facts replace the old fresh/imported mode:
 * `jobsVolumeName` declares the live Postgres volume as soon as it is known
 * (discovered or imported), so a later plan can never propose deleting it, and
 * `secretsSeeded` records that credential variables exist on the providers, so
 * they are preserve()d exactly from that point on.
 */
export type DeploymentInput = CommonDeploymentInput & {
  jobsVolumeName?: string;
  secretsSeeded: boolean;
};

export interface RailwayTarget {
  projectId: string;
  environmentId: string;
}

export type BootstrapState =
  | { phase: "unlinked" }
  | ({ phase: "linked" } & RailwayTarget)
  | ({ phase: "provisioned"; jobsVolumeName: string } & RailwayTarget);

export type CloudflareBootstrapState =
  | { phase: "pending" }
  | { phase: "changed" }
  | { phase: "ready" };

function required(environment: Environment, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`Missing deployment input ${key}`);
  if (/[\r\n]/u.test(value)) throw new Error(`Deployment input ${key} must be one line`);
  return value;
}

function hostname(environment: Environment, key: string): string {
  const value = required(environment, key);
  const url = new URL(`https://${value}`);
  if (url.hostname !== value || url.pathname !== "/" || url.search || url.hash || url.port) {
    throw new Error(`Deployment input ${key} must be a hostname without a scheme or path`);
  }
  return value;
}

function httpsUrl(environment: Environment, key: string): string {
  const value = required(environment, key);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Deployment input ${key} must be an HTTPS origin without credentials, a path, or a query`,
    );
  }
  return url.toString().replace(/\/$/u, "");
}

function r2Endpoint(environment: Environment): { endpoint: string; accountId: string } {
  const endpoint = httpsUrl(environment, "SHUTTER_R2_ENDPOINT");
  const hostname = new URL(endpoint).hostname;
  const match = /^([a-f0-9]{32})(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/u.exec(hostname);
  if (!match) {
    throw new Error("Deployment input SHUTTER_R2_ENDPOINT must contain a Cloudflare account ID");
  }
  return { endpoint, accountId: match[1] };
}

function repository(environment: Environment): string {
  const value = required(environment, "SHUTTER_GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error("Deployment input SHUTTER_GITHUB_REPOSITORY must be owner/repository");
  }
  return value;
}

function identifier(environment: Environment, key: string): string {
  const value = required(environment, key);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value)) {
    throw new Error(`Deployment input ${key} contains unsupported characters`);
  }
  return value;
}

function r2Bucket(environment: Environment): string {
  const value = required(environment, "SHUTTER_R2_BUCKET");
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(value)) {
    throw new Error(
      "Deployment input SHUTTER_R2_BUCKET must be 3-63 lowercase letters, numbers, or hyphens",
    );
  }
  return value;
}

function allowedSources(environment: Environment): string {
  const value = required(environment, "SHUTTER_IMGPROXY_ALLOWED_SOURCES");
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error("Deployment input SHUTTER_IMGPROXY_ALLOWED_SOURCES has an empty entry");
  }
  for (const entry of entries) {
    const url = new URL(entry);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Deployment input SHUTTER_IMGPROXY_ALLOWED_SOURCES must contain HTTPS URLs");
    }
  }
  return entries.join(",");
}

function volumeName(environment: Environment): string | undefined {
  const value = environment.SHUTTER_JOBS_VOLUME_NAME?.trim();
  if (value && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value)) {
    throw new Error("Deployment input SHUTTER_JOBS_VOLUME_NAME contains unsupported characters");
  }
  return value || undefined;
}

function secretsSeeded(environment: Environment): boolean {
  const value = environment.SHUTTER_SECRETS_SEEDED?.trim();
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error("Deployment input SHUTTER_SECRETS_SEEDED must be true or false");
}

export interface EdgeDeploymentInput {
  edgeWorkerName: string;
  r2Bucket: string;
  cloudflareAccountId?: string;
  edgeDomain?: string;
}

// The subset a Worker version upload actually bakes into the version: the
// Worker name and the R2 binding's bucket. Account ID and routes are optional
// because Workers Builds injects CLOUDFLARE_ACCOUNT_ID and a version upload
// never applies routes.
export function parseEdgeDeploymentInput(environment: Environment): EdgeDeploymentInput {
  const input: EdgeDeploymentInput = {
    edgeWorkerName: identifier(environment, "SHUTTER_EDGE_WORKER_NAME"),
    r2Bucket: r2Bucket(environment),
  };
  if (environment.SHUTTER_R2_ENDPOINT) {
    input.cloudflareAccountId = r2Endpoint(environment).accountId;
  }
  if (environment.SHUTTER_EDGE_DOMAIN) {
    input.edgeDomain = hostname(environment, "SHUTTER_EDGE_DOMAIN");
  }
  return Object.freeze(input);
}

export function parseDeploymentInput(environment: Environment): DeploymentInput {
  const jobsVolumeName = volumeName(environment);
  const r2Region = required(environment, "SHUTTER_R2_REGION");
  if (!/^[A-Za-z0-9-]+$/u.test(r2Region)) {
    throw new Error("Deployment input SHUTTER_R2_REGION contains unsupported characters");
  }
  const r2 = r2Endpoint(environment);
  const common = {
    projectName: identifier(environment, "SHUTTER_PROJECT_NAME"),
    repository: repository(environment),
    railwayRegion: identifier(environment, "SHUTTER_RAILWAY_REGION"),
    controlDomain: hostname(environment, "SHUTTER_CONTROL_DOMAIN"),
    edgeWorkerName: identifier(environment, "SHUTTER_EDGE_WORKER_NAME"),
    edgeDomain: hostname(environment, "SHUTTER_EDGE_DOMAIN"),
    r2Bucket: r2Bucket(environment),
    r2Endpoint: r2.endpoint,
    r2Region,
    cloudflareAccountId: r2.accountId,
    cloudflareZoneId: identifier(environment, "SHUTTER_CLOUDFLARE_ZONE_ID"),
    imgproxyAllowedSources: allowedSources(environment),
  };
  return Object.freeze({
    ...common,
    secretsSeeded: secretsSeeded(environment),
    ...(jobsVolumeName === undefined ? {} : { jobsVolumeName }),
  });
}

export function parseRailwayTarget(environment: Environment): RailwayTarget {
  const projectId = required(environment, "SHUTTER_RAILWAY_PROJECT_ID");
  const environmentId = required(environment, "SHUTTER_RAILWAY_ENVIRONMENT_ID");
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
  if (!uuid.test(projectId) || !uuid.test(environmentId)) {
    throw new Error("Railway target IDs in the deployment input are invalid");
  }
  return Object.freeze({ projectId, environmentId });
}

export function parseBootstrapState(environment: Environment): BootstrapState {
  parseDeploymentInput(environment);
  const jobsVolumeName = volumeName(environment);
  const hasProject = Boolean(environment.SHUTTER_RAILWAY_PROJECT_ID?.trim());
  const hasEnvironment = Boolean(environment.SHUTTER_RAILWAY_ENVIRONMENT_ID?.trim());
  if (hasProject !== hasEnvironment) throw new Error("Railway target state is incomplete");
  const target = hasProject ? parseRailwayTarget(environment) : undefined;
  if (!target && jobsVolumeName) throw new Error("Recorded volume state has no Railway target");
  if (!target) return { phase: "unlinked" };
  if (!jobsVolumeName) return { phase: "linked", ...target };
  return { phase: "provisioned", jobsVolumeName, ...target };
}

export function parseCloudflareBootstrapState(environment: Environment): CloudflareBootstrapState {
  const readyAccountId = environment.SHUTTER_R2_READY_ACCOUNT_ID?.trim();
  const readyBucket = environment.SHUTTER_R2_READY_BUCKET?.trim();
  if (!readyAccountId && !readyBucket) return { phase: "pending" };
  if (!readyAccountId || !readyBucket) throw new Error("Cloudflare R2 ready state is incomplete");
  const currentR2 = r2Endpoint(environment);
  const currentBucket = r2Bucket(environment);
  return readyAccountId === currentR2.accountId && readyBucket === currentBucket
    ? { phase: "ready" }
    : { phase: "changed" };
}

export function parseDeploymentEnvFile(source: string): Environment {
  const values: Environment = {};
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error(`Invalid deployment input on line ${index + 1}`);
    const [, key, value] = match;
    if (!(publicInputKeys as readonly string[]).includes(key)) {
      throw new Error(`Unsupported key ${key} in deployment input file`);
    }
    if (value.includes("=") || /\s/u.test(value)) {
      throw new Error(`Deployment input ${key} must not contain spaces or '='`);
    }
    values[key] = value;
  }
  return values;
}

export { publicInputKeys };
