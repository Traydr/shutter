import { readFile } from "node:fs/promises";
import { projectDefinitionToGraph } from "railway/iac";
import { describe, expect, it } from "vitest";
import {
  parseBootstrapState,
  parseCloudflareBootstrapState,
  parseDeploymentEnvFile,
  parseDeploymentInput,
  parseRailwayTarget,
} from "../.railway/deployment-input.ts";
import { buildRailwayProject } from "../.railway/railway.ts";
import { createEdgeDeploymentConfig } from "../scripts/deployment-config.ts";

const commonEnvironment = {
  SHUTTER_PROJECT_NAME: "example-shutter",
  SHUTTER_GITHUB_REPOSITORY: "example/shutter",
  SHUTTER_RAILWAY_REGION: "us-west2",
  SHUTTER_CONTROL_DOMAIN: "control.example.com",
  SHUTTER_EDGE_WORKER_NAME: "example-shutter-edge",
  SHUTTER_EDGE_DOMAIN: "media.example.com",
  SHUTTER_R2_BUCKET: "example-renditions",
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
      value: "example-renditions",
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
      value: "example-renditions",
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

  it("keeps secret-looking and unknown values out of the public input file", () => {
    expect(() => parseDeploymentEnvFile("ADMIN_BOOTSTRAP_TOKEN=secret\n")).toThrow(
      "Unsupported key",
    );
    expect(() => parseDeploymentEnvFile("SHUTTER_PROJECT_NAME=a value\n")).toThrow(
      "must not contain spaces",
    );
    expect(() => parseDeploymentEnvFile("SHUTTER_FRESH_TOPOLOGY_APPLIED=1\n")).toThrow(
      "Unsupported key",
    );
    expect(() => parseDeploymentEnvFile("SHUTTER_DEPLOYMENT_MODE=fresh\n")).toThrow(
      "Unsupported key",
    );
  });

  it("renders owner-specific Worker values only into the ignored deployment config", async () => {
    const base = JSON.parse(await readFile("apps/edge/wrangler.jsonc", "utf8"));
    const deployed = createEdgeDeploymentConfig(base, { ...commonEnvironment });

    expect(base.name).toBe("shutter-edge-local");
    expect(base.routes).toBeUndefined();
    expect(deployed.name).toBe("example-shutter-edge");
    expect(deployed.account_id).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(deployed.routes).toEqual([{ pattern: "media.example.com", custom_domain: true }]);
    expect(deployed.r2_buckets).toEqual([
      { binding: "RENDITION_STORE", bucket_name: "example-renditions" },
    ]);
    expect(deployed.compatibility_flags).toBeUndefined();
  });

  it("models the bootstrap phases", () => {
    const target = {
      SHUTTER_RAILWAY_PROJECT_ID: "3c9a6c56-1119-4167-9e3b-bc7eaee0a8c0",
      SHUTTER_RAILWAY_ENVIRONMENT_ID: "8fdf159b-2d2b-4a7e-83c5-045b5a89dd5d",
    };
    expect(parseBootstrapState({ ...commonEnvironment })).toEqual({ phase: "unlinked" });
    expect(parseBootstrapState({ ...commonEnvironment, ...target })).toEqual({
      phase: "linked",
      ...parseRailwayTarget(target),
    });
    expect(
      parseBootstrapState({
        ...commonEnvironment,
        SHUTTER_JOBS_VOLUME_NAME: "jobs-volume",
        ...target,
      }),
    ).toEqual({
      phase: "provisioned",
      jobsVolumeName: "jobs-volume",
      ...parseRailwayTarget(target),
    });
  });

  it("rejects partial or unbound bootstrap state", () => {
    expect(() =>
      parseBootstrapState({
        ...commonEnvironment,
        SHUTTER_RAILWAY_PROJECT_ID: "3c9a6c56-1119-4167-9e3b-bc7eaee0a8c0",
      }),
    ).toThrow("incomplete");
    expect(() =>
      parseBootstrapState({
        ...commonEnvironment,
        SHUTTER_JOBS_VOLUME_NAME: "unbound-volume",
      }),
    ).toThrow("no Railway target");
  });

  it("models Cloudflare progress separately from Railway progress", () => {
    expect(parseCloudflareBootstrapState(commonEnvironment)).toEqual({ phase: "pending" });
    expect(
      parseCloudflareBootstrapState({
        ...commonEnvironment,
        SHUTTER_R2_READY_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SHUTTER_R2_READY_BUCKET: "example-renditions",
      }),
    ).toEqual({ phase: "ready" });
    expect(
      parseCloudflareBootstrapState({
        ...commonEnvironment,
        SHUTTER_R2_READY_ACCOUNT_ID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        SHUTTER_R2_READY_BUCKET: "old-renditions",
      }),
    ).toEqual({ phase: "changed" });
    expect(() =>
      parseCloudflareBootstrapState({
        ...commonEnvironment,
        SHUTTER_R2_READY_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow("incomplete");
  });

  it("retains the R2 lifecycle and imgproxy network guards", async () => {
    const lifecycle = JSON.parse(await readFile("infra/cloudflare/r2-lifecycle.json", "utf8"));
    expect(lifecycle.rules).toEqual([
      {
        id: "expire-disposable-renditions-after-30-days",
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
