/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: Railway resolves service references at deploy time. */
import {
  defineRailway,
  github,
  group,
  image,
  postgres,
  preserve,
  project,
  ref,
  type ServiceConfigInput,
  service,
  type VariableValue,
  volume,
} from "railway/iac";
import { parseDeploymentInput } from "./deployment-input.ts";

const nodePort = 8080;
const imgproxyPort = 8080;
const workspaceWatchPatterns = ["/package.json", "/pnpm-lock.yaml", "/pnpm-workspace.yaml"];
const executorWatchPatterns = [
  "/packages/executor-runtime/**",
  "/packages/protocol/**",
  ...workspaceWatchPatterns,
];

/** The variables of one service as the Railway SDK accepts them. */
type ServiceEnv = NonNullable<ServiceConfigInput["env"]>;

function preserved<K extends string>(names: readonly K[]): Record<K, VariableValue> {
  // SAFETY: `names` is exactly the key set K, and every entry maps to a preserve() value.
  return Object.fromEntries(names.map((name) => [name, preserve()] as const)) as Record<
    K,
    VariableValue
  >;
}

export function buildRailwayProject(environment: NodeJS.ProcessEnv) {
  const input = parseDeploymentInput(environment);
  // Only credentials are ever preserve()d, and only once the credential stage
  // has seeded them. Every non-secret value is an unconditional literal from
  // the deployment input, so changing the input actually changes the plan.
  const seeded = input.secretsSeeded;
  const repository = github(input.repository);
  const s3PublicEnv = {
    S3_BUCKET: input.r2Bucket,
    S3_ENDPOINT: input.r2Endpoint,
    S3_REGION: input.r2Region,
  };
  const s3CredentialEnv: Record<string, VariableValue> = seeded
    ? preserved(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])
    : {};
  const s3Env = { ...s3PublicEnv, ...s3CredentialEnv };
  const imgproxyCredentialEnv: Record<string, VariableValue> = seeded
    ? preserved(["IMGPROXY_KEY", "IMGPROXY_SALT", "IMGPROXY_SECRET"])
    : {};

  const Imgproxy = service("Shutter-Imgproxy", {
    source: image("ghcr.io/imgproxy/imgproxy:v4.0.3", {
      autoUpdates: { type: "disabled" },
    }),
    replicas: { [input.railwayRegion]: 1 },
    healthcheck: "/health",
    healthcheckTimeout: 30,
    networking: { privateNetworkEndpoint: "shutter-imgproxy" },
    env: {
      IMGPROXY_ALLOWED_SOURCES: input.imgproxyAllowedSources,
      IMGPROXY_ALLOW_LINK_LOCAL_SOURCE_ADDRESSES: "false",
      IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES: "false",
      IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES: "false",
      IMGPROXY_ALLOW_SECURITY_OPTIONS: "false",
      IMGPROXY_BIND: `:${imgproxyPort}`,
      IMGPROXY_DOWNLOAD_TIMEOUT: "30",
      IMGPROXY_IGNORE_SSL_VERIFICATION: "false",
      IMGPROXY_MAX_ANIMATION_FRAMES: "1",
      IMGPROXY_MAX_REDIRECTS: "2",
      IMGPROXY_MAX_RESULT_DIMENSION: "3840",
      IMGPROXY_MAX_SRC_FILE_SIZE: "134217728",
      IMGPROXY_MAX_SRC_RESOLUTION: "50",
      IMGPROXY_PNG_UNLIMITED: "false",
      IMGPROXY_SIGNATURE_SIZE: "32",
      IMGPROXY_SVG_UNLIMITED: "false",
      IMGPROXY_TIMEOUT: "45",
      IMGPROXY_TTL: "0",
      ...imgproxyCredentialEnv,
      ...s3Env,
    },
  });

  const Jobs = postgres("Shutter-Jobs", { region: input.railwayRegion });
  // Railway IaC 3.5.2 creates this volume implicitly for postgres(), but does
  // not retain it in the next desired graph. Declare the live volume as soon
  // as its name is known (discovered after the first apply, or supplied for an
  // imported project) so later plans cannot propose deleting the database's
  // attached storage.
  const JobsVolume = input.jobsVolumeName
    ? volume(input.jobsVolumeName, {
        allowOnlineResize: true,
        region: input.railwayRegion,
        sizeMB: 50_000,
        alerts: { usage: { "80": {}, "95": {}, "100": {} } },
      })
    : undefined;

  const controlSecretEnv: Record<string, VariableValue> = seeded
    ? preserved([
        "ADMIN_BOOTSTRAP_TOKEN",
        "CLOUDFLARE_CACHE_PURGE_TOKEN",
        "EDGE_CONFIG_TOKEN",
        "IMGPROXY_KEY",
        "IMGPROXY_SALT",
        "IMGPROXY_SECRET",
        "ORIGIN_AUTH_TOKEN",
        "PDF_EXECUTOR_TOKEN",
        "SHUTTER_ENCRYPTION_KEY",
        "VIDEO_EXECUTOR_TOKEN",
      ])
    : {};
  const observabilityEnv: Record<string, string | VariableValue> = seeded
    ? {
        ...preserved([
          "OTEL_EXPORTER_OTLP_LOGS_ALLOWED_ENDPOINTS",
          "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
          "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
        ]),
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "5000",
      }
    : {};

  const controlEnv: ServiceEnv = {
    CLOUDFLARE_ZONE_ID: input.cloudflareZoneId,
    DATABASE_URL: Jobs.env.DATABASE_URL,
    EDGE_BASE_URL: `https://${input.edgeDomain}`,
    IMGPROXY_BASE_URL: `http://\${{Shutter-Imgproxy.RAILWAY_PRIVATE_DOMAIN}}:${imgproxyPort}`,
    IMGPROXY_ALLOWED_SOURCES: Imgproxy.env.IMGPROXY_ALLOWED_SOURCES,
    NODE_ENV: "production",
    PDF_EXECUTOR_BASE_URL: `http://\${{Shutter-Executor-PDF.RAILWAY_PRIVATE_DOMAIN}}:${nodePort}`,
    PORT: String(nodePort),
    VIDEO_EXECUTOR_BASE_URL: `http://\${{Shutter-Executor-Video.RAILWAY_PRIVATE_DOMAIN}}:${nodePort}`,
    ...controlSecretEnv,
    ...observabilityEnv,
    ...s3Env,
  };

  const Control = service("Shutter-Control", {
    source: repository,
    build: {
      builder: "RAILPACK",
      buildEnvironment: "V3",
      buildCommand: "pnpm --filter @shutter/control... build",
      watchPatterns: ["/apps/control/**", "/packages/protocol/**", ...workspaceWatchPatterns],
    },
    start: "pnpm --filter @shutter/control start",
    preDeploy: "pnpm --filter @shutter/control db:migrate",
    replicas: { [input.railwayRegion]: 1 },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    deploy: { drainingSeconds: 15 },
    networking: { privateNetworkEndpoint: "shutter-control" },
    domains: [{ domain: input.controlDomain, port: nodePort }],
    env: controlEnv,
  });

  const executorEnvironment = (roleToken: "PDF_EXECUTOR_TOKEN" | "VIDEO_EXECUTOR_TOKEN") => {
    const values: ServiceEnv = {
      CONTROL_BASE_URL: `http://\${{Shutter-Control.RAILWAY_PRIVATE_DOMAIN}}:${nodePort}`,
      NODE_ENV: "production",
      PORT: String(nodePort),
      ...s3Env,
    };
    if (seeded) values.EXECUTOR_ROLE_TOKEN = ref(Control, roleToken);
    return values;
  };

  const VideoExecutor = service("Shutter-Executor-Video", {
    source: repository,
    build: {
      builder: "RAILPACK",
      buildEnvironment: "V3",
      buildCommand: "pnpm --filter @shutter/executor-video... build",
      watchPatterns: ["/apps/executor-video/**", ...executorWatchPatterns],
    },
    start: "pnpm --filter @shutter/executor-video start",
    replicas: { [input.railwayRegion]: 1 },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    deploy: { sleepApplication: true },
    networking: { privateNetworkEndpoint: "shutter-executor-video" },
    env: {
      ...executorEnvironment("VIDEO_EXECUTOR_TOKEN"),
      RAILPACK_DEPLOY_APT_PACKAGES: "ffmpeg",
    },
  });

  const PdfExecutor = service("Shutter-Executor-PDF", {
    source: repository,
    build: {
      builder: "RAILPACK",
      buildEnvironment: "V3",
      buildCommand: "pnpm --filter @shutter/executor-pdf... build",
      watchPatterns: ["/apps/executor-pdf/**", ...executorWatchPatterns],
    },
    start: "pnpm --filter @shutter/executor-pdf start",
    replicas: { [input.railwayRegion]: 1 },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    deploy: { sleepApplication: true },
    networking: { privateNetworkEndpoint: "shutter-executor-pdf" },
    env: {
      ...executorEnvironment("PDF_EXECUTOR_TOKEN"),
      RAILPACK_DEPLOY_APT_PACKAGES: "ffmpeg poppler-utils",
    },
  });

  const Delivery = group("Delivery", [Control, Imgproxy, VideoExecutor, PdfExecutor]);
  return project(input.projectName, {
    resources: [Delivery, Jobs, ...(JobsVolume ? [JobsVolume] : [])],
  });
}

export default defineRailway(() => buildRailwayProject(process.env));
