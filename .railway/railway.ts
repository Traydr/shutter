/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: Railway resolves service references at deploy time. */
import {
  defineRailway,
  github,
  group,
  image,
  postgres,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

const region = "europe-west4-drams3a";
const nodePort = 8080;
const imgproxyPort = 8080;
const repository = github("Traydr/shutter");
const workspaceWatchPatterns = ["/package.json", "/pnpm-lock.yaml", "/pnpm-workspace.yaml"];
const executorWatchPatterns = [
  "/packages/executor-runtime/**",
  "/packages/protocol/**",
  ...workspaceWatchPatterns,
];

export default defineRailway(() => {
  // These preserved values are the S3-compatible credentials for the same
  // Cloudflare R2 `shutter-renditions` bucket bound natively to Edge. Keep the
  // values identical across Control, imgproxy, and both Executors.
  const s3Env = {
    S3_ACCESS_KEY_ID: preserve(),
    S3_BUCKET: preserve(),
    S3_ENDPOINT: preserve(),
    S3_REGION: preserve(),
    S3_SECRET_ACCESS_KEY: preserve(),
  };

  const Imgproxy = service("Shutter-Imgproxy", {
    source: image("ghcr.io/imgproxy/imgproxy:v4.0.3", {
      autoUpdates: { type: "disabled" },
    }),
    replicas: { [region]: 1 },
    healthcheck: "/health",
    healthcheckTimeout: 30,
    networking: { privateNetworkEndpoint: "shutter-imgproxy" },
    env: {
      // The comma-separated allowlist of source origins imgproxy may fetch from.
      // Deployment-specific: it names the application-owned upload buckets plus
      // the Rendition Store, so it is preserved rather than committed.
      IMGPROXY_ALLOWED_SOURCES: preserve(),
      IMGPROXY_ALLOW_LINK_LOCAL_SOURCE_ADDRESSES: "false",
      IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES: "false",
      IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES: "false",
      IMGPROXY_ALLOW_SECURITY_OPTIONS: "false",
      IMGPROXY_BIND: `:${imgproxyPort}`,
      IMGPROXY_DOWNLOAD_TIMEOUT: "30",
      IMGPROXY_IGNORE_SSL_VERIFICATION: "false",
      IMGPROXY_KEY: preserve(),
      IMGPROXY_MAX_ANIMATION_FRAMES: "1",
      IMGPROXY_MAX_REDIRECTS: "2",
      IMGPROXY_MAX_RESULT_DIMENSION: "3840",
      IMGPROXY_MAX_SRC_FILE_SIZE: "134217728",
      IMGPROXY_MAX_SRC_RESOLUTION: "50",
      IMGPROXY_PNG_UNLIMITED: "false",
      IMGPROXY_SALT: preserve(),
      IMGPROXY_SECRET: preserve(),
      IMGPROXY_SIGNATURE_SIZE: "32",
      IMGPROXY_SVG_UNLIMITED: "false",
      IMGPROXY_TIMEOUT: "45",
      IMGPROXY_TTL: "0",
      ...s3Env,
    },
  });

  const Jobs = postgres("Shutter-Jobs", { region });
  // Railway IaC 3.5.2 creates this volume implicitly for postgres(), but does not
  // retain it in the next desired graph. Declare the live volume so later plans
  // cannot propose deleting the database's attached storage.
  const JobsVolume = volume("shutter-jobs-volume-dilc", {
    allowOnlineResize: true,
    region,
    sizeMB: 50_000,
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  });

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
    replicas: { [region]: 1 },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    deploy: { drainingSeconds: 15 },
    networking: { privateNetworkEndpoint: "shutter-control" },
    domains: [{ domain: "shutter-control.traydr.dev", port: nodePort }],
    env: {
      CLOUDFLARE_CACHE_PURGE_TOKEN: preserve(),
      CLOUDFLARE_ZONE_ID: preserve(),
      ADMIN_BOOTSTRAP_TOKEN: preserve(),
      DATABASE_URL: Jobs.env.DATABASE_URL,
      EDGE_BASE_URL: preserve(),
      EDGE_CONFIG_TOKEN: preserve(),
      IMGPROXY_BASE_URL: `http://\${{Shutter-Imgproxy.RAILWAY_PRIVATE_DOMAIN}}:${imgproxyPort}`,
      IMGPROXY_ALLOWED_SOURCES: Imgproxy.env.IMGPROXY_ALLOWED_SOURCES,
      IMGPROXY_KEY: preserve(),
      IMGPROXY_SALT: preserve(),
      IMGPROXY_SECRET: preserve(),
      NODE_ENV: "production",
      OTEL_EXPORTER_OTLP_LOGS_ALLOWED_ENDPOINTS: preserve(),
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: preserve(),
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: preserve(),
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "5000",
      ORIGIN_AUTH_TOKEN: preserve(),
      PDF_EXECUTOR_BASE_URL: `http://\${{Shutter-Executor-PDF.RAILWAY_PRIVATE_DOMAIN}}:${nodePort}`,
      PDF_EXECUTOR_TOKEN: preserve(),
      PORT: String(nodePort),
      SHUTTER_ENCRYPTION_KEY: preserve(),
      VIDEO_EXECUTOR_BASE_URL: `http://\${{Shutter-Executor-Video.RAILWAY_PRIVATE_DOMAIN}}:${nodePort}`,
      VIDEO_EXECUTOR_TOKEN: preserve(),
      ...s3Env,
    },
  });

  const VideoExecutor = service("Shutter-Executor-Video", {
    source: repository,
    build: {
      builder: "RAILPACK",
      buildEnvironment: "V3",
      buildCommand: "pnpm --filter @shutter/executor-video... build",
      watchPatterns: ["/apps/executor-video/**", ...executorWatchPatterns],
    },
    start: "pnpm --filter @shutter/executor-video start",
    replicas: { [region]: 1 },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    deploy: { sleepApplication: true },
    networking: { privateNetworkEndpoint: "shutter-executor-video" },
    env: {
      CONTROL_BASE_URL: `http://\${{Shutter-Control.RAILWAY_PRIVATE_DOMAIN}}:${nodePort}`,
      EXECUTOR_ROLE_TOKEN: Control.env.VIDEO_EXECUTOR_TOKEN,
      NODE_ENV: "production",
      PORT: String(nodePort),
      RAILPACK_DEPLOY_APT_PACKAGES: "ffmpeg",
      ...s3Env,
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
    replicas: { [region]: 1 },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    deploy: { sleepApplication: true },
    networking: { privateNetworkEndpoint: "shutter-executor-pdf" },
    env: {
      CONTROL_BASE_URL: `http://\${{Shutter-Control.RAILWAY_PRIVATE_DOMAIN}}:${nodePort}`,
      EXECUTOR_ROLE_TOKEN: Control.env.PDF_EXECUTOR_TOKEN,
      NODE_ENV: "production",
      PORT: String(nodePort),
      RAILPACK_DEPLOY_APT_PACKAGES: "ffmpeg poppler-utils",
      ...s3Env,
    },
  });

  const Delivery = group("Delivery", [Control, Imgproxy, VideoExecutor, PdfExecutor]);
  return project("shutter", { resources: [Delivery, Jobs, JobsVolume] });
});
