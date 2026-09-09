import { describe, expect, it } from "vitest";
import { isBucketName, parseSpacePolicy, SpacePolicyValidationError } from "./space-policy.js";

const validPublicPolicy = {
  id: "example-public",
  routeClass: "public",
  qualities: [30, 50, 75],
  defaultQuality: 75,
  allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/media/" }],
  resolvers: [{ id: "uploadthing", type: "uploadthing", allowedProjectIds: ["project_one"] }],
};

describe("isBucketName", () => {
  it("applies the general-purpose S3 rules", () => {
    for (const name of ["images", "ernesta-images", "a.b.c", "abc"])
      expect(isBucketName(name)).toBe(true);
    for (const name of [
      "a",
      "ab",
      "a..b",
      "192.168.1.1",
      "Images",
      "-images",
      "images-",
      "a".repeat(64),
    ]) {
      expect(isBucketName(name)).toBe(false);
    }
  });
});

describe("parseSpacePolicy", () => {
  it("parses and normalizes the public Space policy", () => {
    expect(parseSpacePolicy(validPublicPolicy)).toEqual({
      ...validPublicPolicy,
      allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/media" }],
    });
  });

  it("canonicalizes a root path prefix by omitting it", () => {
    for (const pathPrefix of ["/", "//", "///"]) {
      expect(
        parseSpacePolicy({
          ...validPublicPolicy,
          allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix }],
        }).allowedSourceOrigins,
      ).toEqual([{ origin: "https://sources.example.com" }]);
    }
  });

  it("is idempotent: its own output is valid input and parses identically", () => {
    for (const pathPrefix of ["/", "//", "/media/", "/media//"]) {
      const once = parseSpacePolicy({
        ...validPublicPolicy,
        allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix }],
      });
      expect(parseSpacePolicy(once)).toEqual(once);
    }
  });

  it("accepts template and S3 resolvers whose expansions sit inside the allowed origins", () => {
    const policy = parseSpacePolicy({
      ...validPublicPolicy,
      allowedSourceOrigins: [
        { origin: "https://project_one.ufs.sh", pathPrefix: "/f" },
        { origin: "https://account.r2.cloudflarestorage.com", pathPrefix: "/images" },
      ],
      resolvers: [
        {
          id: "ut",
          type: "template",
          url: "https://{project}.ufs.sh/f/{file}",
          placeholders: { project: { allowed: ["project_one"] }, file: {} },
        },
        {
          id: "media",
          type: "s3",
          endpoint: "https://account.r2.cloudflarestorage.com/",
          region: "auto",
          bucket: "images",
          pathStyle: true,
          keyTemplate: "{key}",
        },
      ],
    });
    expect(policy.resolvers).toEqual([
      {
        id: "ut",
        type: "template",
        url: "https://{project}.ufs.sh/f/{file}",
        placeholders: { project: { allowed: ["project_one"] }, file: {} },
      },
      {
        id: "media",
        type: "s3",
        endpoint: "https://account.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "images",
        pathStyle: true,
        keyTemplate: "{key}",
      },
    ]);
    expect(parseSpacePolicy(policy)).toEqual(policy);
  });

  it("names the resolver whose expansion leaves the allowed origins", () => {
    expect(() =>
      parseSpacePolicy({
        ...validPublicPolicy,
        resolvers: [
          {
            id: "lw",
            type: "template",
            url: "https://latch.example/{token}",
            placeholders: { token: {} },
          },
        ],
      }),
    ).toThrow("resolver lw can produce a location outside allowedSourceOrigins");
  });

  it("accepts a private Space with or without Source Resolvers", () => {
    expect(
      parseSpacePolicy({
        ...validPublicPolicy,
        id: "example-private",
        routeClass: "private",
        resolvers: [],
      }),
    ).toMatchObject({ id: "example-private", routeClass: "private", resolvers: [] });
    expect(
      parseSpacePolicy({
        ...validPublicPolicy,
        id: "example-private",
        routeClass: "private",
        resolvers: [
          {
            id: "media",
            type: "template",
            url: "https://sources.example.com/media/{key}",
            placeholders: { key: {} },
          },
        ],
      }).resolvers,
    ).toHaveLength(1);
  });

  it.each([
    ["unknown route class", { ...validPublicPolicy, routeClass: "shared" }],
    [
      "origin credentials",
      {
        ...validPublicPolicy,
        allowedSourceOrigins: [{ origin: "https://user:pass@sources.example.com" }],
      },
    ],
    [
      "origin path",
      {
        ...validPublicPolicy,
        allowedSourceOrigins: [{ origin: "https://sources.example.com/media" }],
      },
    ],
    [
      "unsupported resolver",
      {
        ...validPublicPolicy,
        resolvers: [{ id: "custom", type: "custom", allowedProjectIds: ["project"] }],
      },
    ],
    [
      "a hostname placeholder without allowed values",
      {
        ...validPublicPolicy,
        resolvers: [
          {
            id: "ut",
            type: "template",
            url: "https://{project}.ufs.sh/f/{file}",
            placeholders: { project: {}, file: {} },
          },
        ],
      },
    ],
    [
      "a hostname value that is not a label",
      {
        ...validPublicPolicy,
        resolvers: [
          {
            id: "ut",
            type: "template",
            url: "https://{project}.ufs.sh/f/{file}",
            placeholders: { project: { allowed: ["a.b"] }, file: {} },
          },
        ],
      },
    ],
    [
      "placeholders that do not match the url",
      {
        ...validPublicPolicy,
        resolvers: [
          {
            id: "lw",
            type: "template",
            url: "https://sources.example.com/media/{token}",
            placeholders: { token: {}, extra: {} },
          },
        ],
      },
    ],
    [
      "an allowed path value outside the reference grammar",
      {
        ...validPublicPolicy,
        resolvers: [
          {
            id: "lw",
            type: "template",
            url: "https://sources.example.com/media/{token}",
            placeholders: { token: { allowed: ["a/b"] } },
          },
        ],
      },
    ],
    [
      "an S3 endpoint with a path",
      {
        ...validPublicPolicy,
        resolvers: [
          {
            id: "media",
            type: "s3",
            endpoint: "https://sources.example.com/media",
            region: "auto",
            bucket: "images",
            pathStyle: true,
            keyTemplate: "{key}",
          },
        ],
      },
    ],
    [
      "an S3 bucket name outside the S3 rules",
      {
        ...validPublicPolicy,
        resolvers: [
          {
            id: "media",
            type: "s3",
            endpoint: "https://sources.example.com",
            region: "auto",
            bucket: "192.168.1.1",
            pathStyle: true,
            keyTemplate: "{key}",
          },
        ],
      },
    ],
    [
      "a dotted bucket with virtual-hosted addressing",
      {
        ...validPublicPolicy,
        resolvers: [
          {
            id: "media",
            type: "s3",
            endpoint: "https://sources.example.com",
            region: "auto",
            bucket: "media.images",
            pathStyle: false,
            keyTemplate: "{key}",
          },
        ],
      },
    ],
    [
      "an S3 key template without a placeholder",
      {
        ...validPublicPolicy,
        resolvers: [
          {
            id: "media",
            type: "s3",
            endpoint: "https://sources.example.com",
            region: "auto",
            bucket: "media",
            pathStyle: true,
            keyTemplate: "static",
          },
        ],
      },
    ],
    [
      "path prefix with a comma",
      {
        ...validPublicPolicy,
        allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/a,b" }],
      },
    ],
    ["quality outside range", { ...validPublicPolicy, qualities: [0, 75] }],
    ["missing default quality", { ...validPublicPolicy, defaultQuality: 80 }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseSpacePolicy(input)).toThrow(SpacePolicyValidationError);
  });
});
