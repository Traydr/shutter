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

function preserved(names: string[]) {
  return Object.fromEntries(names.map((name) => [name, preserve()]));
}

export function buildRailwayProject(environment: NodeJS.ProcessEnv) {
  const input = parseDeploymentInput(environment);
  const imported = input.mode === "imported";
  const repository = github(input.repository);
  const s3PublicEnv: Record<string, string | VariableValue> = imported
    ? preserved(["S3_BUCKET", "S3_ENDPOINT", "S3_REGION"])
    : {
        S3_BUCKET: input.r2Bucket,
        S3_ENDPOINT: input.r2Endpoint,
        S3_REGION: input.r2Region,
      };
  const s3CredentialEnv: Record<string, VariableValue> = imported
    ? preserved(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])
    : {};
  const s3Env = { ...s3PublicEnv, ...s3CredentialEnv };
  const imgproxyCredentialEnv: Record<string, VariableValue> = imported
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
      IMGPROXY_ALLOWED_SOURCES: imported ? preserve() : input.imgproxyAllowedSources,
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
  const JobsVolume =
    input.mode === "imported"
      ? volume(input.jobsVolumeName, {
          allowOnlineResize: true,
          region: input.railwayRegion,
          sizeMB: 50_000,
          alerts: { usage: { "80": {}, "95": {}, "100": {} } },
        })
      : undefined;

  const controlSecretEnv: Record<string, VariableValue> = imported
    ? {
        ADMIN_BOOTSTRAP_TOKEN: preserve(),
        CLOUDFLARE_CACHE_PURGE_TOKEN: preserve(),
        EDGE_CONFIG_TOKEN: preserve(),
        IMGPROXY_KEY: preserve(),
        IMGPROXY_SALT: preserve(),
        IMGPROXY_SECRET: preserve(),
        ORIGIN_AUTH_TOKEN: preserve(),
        PDF_EXECUTOR_TOKEN: preserve(),
        SHUTTER_ENCRYPTION_KEY: preserve(),
        VIDEO_EXECUTOR_TOKEN: preserve(),
      }
    : {};
  const observabilityEnv: Record<string, string | VariableValue> = imported
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

  const controlEnv: Record<string, string | VariableValue> = {
    CLOUDFLARE_ZONE_ID: imported ? preserve() : input.cloudflareZoneId,
    DATABASE_URL: Jobs.env.DATABASE_URL,
    EDGE_BASE_URL: imported ? preserve() : `https://${input.edgeDomain}`,
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
    const values: Record<string, string | VariableValue> = {
      CONTROL_BASE_URL: `http://\${{Shutter-Control.RAILWAY_PRIVATE_DOMAIN}}:${nodePort}`,
      NODE_ENV: "production",
      PORT: String(nodePort),
      ...s3Env,
    };
    if (imported) values.EXECUTOR_ROLE_TOKEN = ref(Control, roleToken);
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
