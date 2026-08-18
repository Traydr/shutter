/**
 * The public, non-secret inputs the Railway topology reads from the
 * environment. Copy `.railway/deployment.example.env` to the ignored
 * `.railway/deployment.env`, `source` it, and run `railway config plan`.
 */
type Environment = Record<string, string | undefined>;

interface CommonDeploymentInput {
  projectName: string;
  repository: string;
  railwayRegion: string;
  controlDomain: string;
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

interface R2Endpoint {
  endpoint: string;
  accountId: string;
}

function r2Endpoint(environment: Environment): R2Endpoint {
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
    edgeDomain: hostname(environment, "SHUTTER_EDGE_DOMAIN"),
    r2Bucket: r2Bucket(environment),
    r2Endpoint: r2.endpoint,
    r2Region,
    cloudflareAccountId: r2.accountId,
    cloudflareZoneId: identifier(environment, "SHUTTER_CLOUDFLARE_ZONE_ID"),
    imgproxyAllowedSources: allowedSources(environment),
  };
  const input: DeploymentInput = { ...common, secretsSeeded: secretsSeeded(environment) };
  if (jobsVolumeName !== undefined) input.jobsVolumeName = jobsVolumeName;
  return Object.freeze(input);
}
