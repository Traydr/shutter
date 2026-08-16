import { readFile } from "node:fs/promises";
import { projectDefinitionToGraph } from "railway/iac";
import { describe, expect, it } from "vitest";
import { parseDeploymentInput } from "../.railway/deployment-input.ts";
import { buildRailwayProject } from "../.railway/railway.ts";

const commonEnvironment = {
  SHUTTER_PROJECT_NAME: "example-shutter",
  SHUTTER_GITHUB_REPOSITORY: "example/shutter",
  SHUTTER_RAILWAY_REGION: "us-west2",
  SHUTTER_CONTROL_DOMAIN: "control.example.com",
  SHUTTER_EDGE_DOMAIN: "media.example.com",
  SHUTTER_R2_BUCKET: "example-media",
  SHUTTER_R2_ENDPOINT: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com",
  SHUTTER_R2_REGION: "auto",
  SHUTTER_CLOUDFLARE_ZONE_ID: "example-zone-id",
  SHUTTER_IMGPROXY_ALLOWED_SOURCES:
    "https://uploads.example.com/,https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/",
};

function graphFor(environment: Record<string, string>) {
  return projectDefinitionToGraph(buildRailwayProject(environment));
}

function service(graph: ReturnType<typeof graphFor>, name: string) {
  const resource = graph.resources.find((entry) => entry.type === "service" && entry.name === name);
  if (
    resource?.type !== "service" ||
    !resource.variables ||
    !resource.source ||
    !resource.networking
  ) {
    throw new Error(`Missing service ${name}`);
  }
  return {
    ...resource,
    variables: resource.variables,
    source: resource.source,
    networking: resource.networking,
  };
}

describe("deployment configuration", () => {
  it("builds an unseeded topology without preserved values", () => {
    const graph = graphFor({ ...commonEnvironment });
    const control = service(graph, "Shutter-Control");
    const imgproxy = service(graph, "Shutter-Imgproxy");

    expect(graph.project.name).toBe("example-shutter");
    expect(graph.resources.some((entry) => entry.type === "volume")).toBe(false);
    expect(control.source.repo).toBe("example/shutter");
    expect(control.networking.customDomains).toEqual({
      "control.example.com": { port: 8080 },
    });
    expect(control.variables.ADMIN_BOOTSTRAP_TOKEN).toBeUndefined();
    expect(control.variables.S3_ACCESS_KEY_ID).toBeUndefined();
    expect(control.variables.S3_BUCKET).toMatchObject({
      type: "literal",
      value: "example-media",
    });
    expect(imgproxy.variables.IMGPROXY_ALLOWED_SOURCES).toMatchObject({
      type: "literal",
      value: commonEnvironment.SHUTTER_IMGPROXY_ALLOWED_SOURCES,
    });
    expect(control.variables.CLOUDFLARE_ZONE_ID).toMatchObject({
      type: "literal",
      value: "example-zone-id",
    });
    expect(control.variables.EDGE_BASE_URL).toMatchObject({
      type: "literal",
      value: "https://media.example.com",
    });
  });

  it("preserves only credentials once seeded, and declares the known volume", () => {
    const graph = graphFor({
      ...commonEnvironment,
      SHUTTER_SECRETS_SEEDED: "true",
      SHUTTER_JOBS_VOLUME_NAME: "existing-jobs-volume",
    });
    const control = service(graph, "Shutter-Control");
    const imgproxy = service(graph, "Shutter-Imgproxy");

    expect(
      graph.resources.some(
        (entry) => entry.type === "volume" && entry.name === "existing-jobs-volume",
      ),
    ).toBe(true);
    expect(control.variables.ADMIN_BOOTSTRAP_TOKEN).toEqual({ type: "preserve" });
    expect(control.variables.SHUTTER_ENCRYPTION_KEY).toEqual({ type: "preserve" });
    expect(control.variables.S3_ACCESS_KEY_ID).toEqual({ type: "preserve" });
    // Non-secret values stay literals: changing the input must change the plan
    // even after bootstrap, or Source purge targets a dead host.
    expect(control.variables.S3_BUCKET).toMatchObject({
      type: "literal",
      value: "example-media",
    });
    expect(control.variables.EDGE_BASE_URL).toMatchObject({
      type: "literal",
      value: "https://media.example.com",
    });
    expect(control.variables.CLOUDFLARE_ZONE_ID).toMatchObject({
      type: "literal",
      value: "example-zone-id",
    });
    expect(imgproxy.variables.IMGPROXY_ALLOWED_SOURCES).toMatchObject({
      type: "literal",
      value: commonEnvironment.SHUTTER_IMGPROXY_ALLOWED_SOURCES,
    });
  });

  it("declares the volume for an unseeded project as soon as the name is known", () => {
    const graph = graphFor({
      ...commonEnvironment,
      SHUTTER_JOBS_VOLUME_NAME: "discovered-jobs-volume",
    });
    const control = service(graph, "Shutter-Control");
    expect(
      graph.resources.some(
        (entry) => entry.type === "volume" && entry.name === "discovered-jobs-volume",
      ),
    ).toBe(true);
    expect(control.variables.ADMIN_BOOTSTRAP_TOKEN).toBeUndefined();
  });

  it("rejects ambiguous seeding state and invalid inputs", () => {
    expect(() =>
      parseDeploymentInput({ ...commonEnvironment, SHUTTER_SECRETS_SEEDED: "maybe" }),
    ).toThrow("must be true or false");
    expect(() =>
      parseDeploymentInput({
        ...commonEnvironment,
        SHUTTER_R2_BUCKET: "Invalid_Bucket",
      }),
    ).toThrow("3-63 lowercase");
  });

  it("binds the Worker to the Media Store on Web standards only", async () => {
    const wrangler = JSON.parse(await readFile("apps/edge/wrangler.jsonc", "utf8"));
    expect(wrangler.name).toBe("shutter-edge");
    expect(wrangler.compatibility_flags).toBeUndefined();
    expect(wrangler.r2_buckets).toEqual([
      { binding: "MEDIA_STORE", bucket_name: "shutter-renditions" },
    ]);
    expect(wrangler.routes).toEqual([{ pattern: "shutter-edge.traydr.dev", custom_domain: true }]);
    expect(wrangler.secrets.required).toEqual([
      "EDGE_CONFIG_TOKEN",
      "ORIGIN_AUTH_TOKEN",
      "ORIGIN_BASE_URL",
    ]);
  });

  it("retains the R2 lifecycle and imgproxy network guards", async () => {
    const lifecycle = JSON.parse(await readFile("infra/cloudflare/r2-lifecycle.json", "utf8"));
    expect(lifecycle.rules).toEqual([
      {
        id: "expire-delivery-cache-after-30-days",
        enabled: true,
        conditions: { prefix: "cache/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 2_592_000 } },
      },
    ]);

    const graph = graphFor({ ...commonEnvironment });
    const imgproxy = service(graph, "Shutter-Imgproxy");
    expect(imgproxy.source.image).toBe("ghcr.io/imgproxy/imgproxy:v4.0.3");
    for (const guard of [
      "IMGPROXY_ALLOW_LINK_LOCAL_SOURCE_ADDRESSES",
      "IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES",
      "IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES",
      "IMGPROXY_ALLOW_SECURITY_OPTIONS",
    ]) {
      expect(imgproxy.variables[guard]).toMatchObject({ type: "literal", value: "false" });
    }
  });
});
