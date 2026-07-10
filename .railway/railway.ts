/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: Railway resolves service references at deploy time. */
import { defineRailway, github, group, image, preserve, project, service } from "railway/iac";

const region = "europe-west4-drams3a";
const nodePort = 8080;
const imgproxyPort = 8080;
const repository = github("Traydr/shutter");
const workspaceWatchPatterns = ["/package.json", "/pnpm-lock.yaml", "/pnpm-workspace.yaml"];

export default defineRailway(() => {
  const Imgproxy = service("Shutter-Imgproxy", {
    source: image("ghcr.io/imgproxy/imgproxy:v4.0.3", {
      autoUpdates: { type: "disabled" },
    }),
    replicas: { [region]: 1 },
    healthcheck: "/health",
    healthcheckTimeout: 30,
    networking: { privateNetworkEndpoint: "shutter-imgproxy" },
    env: {
      IMGPROXY_ALLOWED_SOURCES: "https://invalid.shutter.invalid/",
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
    },
  });

  const Control = service("Shutter-Control", {
    source: repository,
    build: {
      builder: "RAILPACK",
      buildEnvironment: "V3",
      buildCommand: "pnpm --filter @shutter/control... build",
      watchPatterns: ["/apps/control/**", ...workspaceWatchPatterns],
    },
    start: "pnpm --filter @shutter/control start",
    replicas: { [region]: 1 },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    networking: { privateNetworkEndpoint: "shutter-control" },
    domains: [{ domain: "shutter-control.traydr.dev", port: nodePort }],
    env: {
      IMGPROXY_BASE_URL: `http://\${{Shutter-Imgproxy.RAILWAY_PRIVATE_DOMAIN}}:${imgproxyPort}`,
      IMGPROXY_KEY: preserve(),
      IMGPROXY_SALT: preserve(),
      IMGPROXY_SECRET: preserve(),
      NODE_ENV: "production",
      ORIGIN_AUTH_TOKEN: preserve(),
      PORT: String(nodePort),
    },
  });

  const Delivery = group("Delivery", [Control, Imgproxy]);
  return project("shutter", { resources: [Delivery] });
});
