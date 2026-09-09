import type { SpacePolicy } from "@shutter/protocol";
import { describe, expect, it, vi } from "vitest";
import { createS3Presigner, createSourceResolverService } from "./source-resolvers.js";

const policy: SpacePolicy = {
  id: "example-public",
  routeClass: "public",
  qualities: [75],
  defaultQuality: 75,
  allowedSourceOrigins: [
    { origin: "https://example-project.ufs.sh", pathPrefix: "/f" },
    { origin: "https://objects.example.test", pathPrefix: "/example-bucket" },
  ],
  resolvers: [
    {
      id: "ut",
      type: "template",
      url: "https://{project}.ufs.sh/f/{file}",
      placeholders: { project: { allowed: ["example-project"] }, file: {} },
    },
    {
      id: "media",
      type: "s3",
      endpoint: "https://objects.example.test",
      region: "auto",
      bucket: "example-bucket",
      pathStyle: true,
      keyTemplate: "originals/{key}",
    },
  ],
};
const now = new Date("2026-09-09T12:00:00.000Z");
const credential = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" };

function service(options: { credential?: typeof credential | undefined; locator?: string } = {}) {
  const presign = vi.fn(
    async () =>
      options.locator ??
      "https://objects.example.test/example-bucket/originals/x?X-Amz-Signature=1",
  );
  const resolvers = createSourceResolverService({
    credentials: { getResolverCredential: async () => options.credential },
    presigner: { presign },
  });
  return { resolvers, presign };
}

describe("source resolver service", () => {
  it("expands a template without touching credentials", async () => {
    const { resolvers, presign } = service();
    await expect(
      resolvers.resolve({
        policy,
        resolverId: "ut",
        reference: ["example-project", "file_9"],
        lifetimeSeconds: 600,
        now,
      }),
    ).resolves.toEqual({
      outcome: "resolved",
      sourceId: "ut/example-project/file_9",
      locator: "https://example-project.ufs.sh/f/file_9",
      expiresAt: new Date("2026-09-09T12:10:00.000Z"),
    });
    expect(presign).not.toHaveBeenCalled();
  });

  it("presigns an S3 reference with the resolver's credential", async () => {
    const { resolvers, presign } = service({ credential });
    const resolution = await resolvers.resolve({
      policy,
      resolverId: "media",
      reference: ["x"],
      lifetimeSeconds: 600,
      now,
    });
    expect(resolution).toMatchObject({ outcome: "resolved", sourceId: "media/x" });
    expect(presign).toHaveBeenCalledWith({
      resolver: policy.resolvers[1],
      credential,
      key: "originals/x",
      expiresInSeconds: 600,
    });
  });

  it("fails closed on a missing credential, an unknown resolver, or a bad reference", async () => {
    const { resolvers } = service();
    await expect(
      resolvers.resolve({
        policy,
        resolverId: "media",
        reference: ["x"],
        lifetimeSeconds: 600,
        now,
      }),
    ).resolves.toEqual({ outcome: "configuration_error" });
    await expect(
      resolvers.resolve({
        policy,
        resolverId: "nope",
        reference: ["x"],
        lifetimeSeconds: 600,
        now,
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    await expect(
      resolvers.resolve({
        policy,
        resolverId: "ut",
        reference: ["other", "f"],
        lifetimeSeconds: 600,
        now,
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    await expect(
      resolvers.resolve({
        policy,
        resolverId: "ut",
        reference: ["example-project"],
        lifetimeSeconds: 600,
        now,
      }),
    ).resolves.toEqual({ outcome: "not_found" });
  });

  it("refuses a presigned locator the allowlist does not cover", async () => {
    const { resolvers } = service({
      credential,
      locator: "https://elsewhere.example/example-bucket/originals/x?sig=1",
    });
    await expect(
      resolvers.resolve({
        policy,
        resolverId: "media",
        reference: ["x"],
        lifetimeSeconds: 600,
        now,
      }),
    ).resolves.toEqual({ outcome: "not_allowed" });
  });
});

describe("S3 presigner", () => {
  it("signs a GET for the resolver's object under the configured addressing style", async () => {
    const presigner = createS3Presigner();
    const resolver = policy.resolvers[1];
    if (resolver?.type !== "s3") throw new Error("fixture");
    const locator = new URL(
      await presigner.presign({
        resolver,
        credential,
        key: "originals/file.one",
        expiresInSeconds: 600,
      }),
    );
    expect(locator.origin).toBe("https://objects.example.test");
    expect(locator.pathname).toBe("/example-bucket/originals/file.one");
    expect(locator.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(locator.searchParams.get("X-Amz-Credential")).toContain("AKIAEXAMPLE");
    expect(locator.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u);

    const virtual = new URL(
      await presigner.presign({
        resolver: { ...resolver, pathStyle: false },
        credential,
        key: "originals/file.one",
        expiresInSeconds: 60,
      }),
    );
    expect(virtual.origin).toBe("https://example-bucket.objects.example.test");
    expect(virtual.pathname).toBe("/originals/file.one");
  });
});
