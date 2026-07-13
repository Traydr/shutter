/**
 * Railway IaC sketch — NOT wired into .railway/railway.ts.
 * Shows how a Shutter-Render service would mirror the imgproxy pattern.
 *
 * To adopt: merge into defineRailway() and build/push Docker image from
 * experiments/executor-perf/go-services/Dockerfile.fitz (or .combined).
 */
import { image, preserve, service } from "railway/iac";

const renderPort = 8080;

export const RenderSketch = service("Shutter-Render", {
  source: image("ghcr.io/traydr/shutter-render:fitz-experiment", {
    autoUpdates: { type: "disabled" },
  }),
  replicas: { "europe-west4-drams3a": 1 },
  healthcheck: "/health",
  healthcheckTimeout: 30,
  networking: { privateNetworkEndpoint: "shutter-render" },
  env: {
    PORT: String(renderPort),
    RENDER_SECRET: preserve(),
  },
});

// PdfExecutor / VideoExecutor would gain:
//   RENDER_BASE_URL: `http://${{Shutter-Render.RAILWAY_PRIVATE_DOMAIN}}:${renderPort}`,
//   RENDER_SECRET: preserve(),
// and could drop RAILPACK_DEPLOY_APT_PACKAGES if render moves entirely to the sidecar.
