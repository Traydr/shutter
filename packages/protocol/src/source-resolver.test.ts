import { describe, expect, it } from "vitest";
import {
  expandS3Resolver,
  expandTemplateResolver,
  parseKeyTemplate,
  parseSourceReference,
  parseUrlTemplate,
  ResolverTemplateError,
  resolverOriginPrefixes,
  resolverPlaceholders,
  resolverSourceId,
  validateResolverOrigins,
} from "./source-resolver.js";
import type { S3ResolverPolicy, TemplateResolverPolicy } from "./types.js";

const uploadThing: TemplateResolverPolicy = {
  id: "ut",
  type: "template",
  url: "https://{project}.ufs.sh/f/{file}",
  placeholders: { project: { allowed: ["ernesta_prod", "ernesta-staging"] }, file: {} },
};

const prefix: TemplateResolverPolicy = {
  id: "lw",
  type: "template",
  url: "https://latch.example/cdn/v1/{token}",
  placeholders: { token: {} },
};

const media: S3ResolverPolicy = {
  id: "media",
  type: "s3",
  endpoint: "https://account.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "ernesta-images",
  pathStyle: true,
  keyTemplate: "originals/{key}",
};

describe("parseUrlTemplate", () => {
  it("names placeholders in order, hostname first", () => {
    const parsed = parseUrlTemplate("https://{project}.ufs.sh/f/{file}");
    expect(parsed.placeholders).toEqual(["project", "file"]);
    expect(parsed.hostPlaceholder).toBe("project");
    expect(parsed.pathSegments).toEqual([
      { kind: "literal", value: "f" },
      { kind: "placeholder", name: "file" },
    ]);
  });

  it("accepts a path-only template and a hostname without a path", () => {
    expect(
      parseUrlTemplate("https://latch.example/cdn/v1/{token}").hostPlaceholder,
    ).toBeUndefined();
    expect(parseUrlTemplate("https://{tenant}.cdn.example").placeholders).toEqual(["tenant"]);
  });

  it.each([
    ["http", "http://cdn.example/{file}"],
    ["a query", "https://cdn.example/{file}?x=1"],
    ["a fragment", "https://cdn.example/{file}#x"],
    ["credentials", "https://user@cdn.example/{file}"],
    ["two hostname placeholders", "https://{a}.{b}.example/{file}"],
    ["a duplicate placeholder", "https://cdn.example/{file}/{file}"],
    ["no placeholder", "https://cdn.example/static/file"],
    ["a partial placeholder", "https://cdn.example/f{file}"],
    ["an empty segment", "https://cdn.example//{file}"],
    ["a trailing slash", "https://cdn.example/{file}/"],
    ["an uppercase name", "https://cdn.example/{File}"],
    ["a dot segment", "https://cdn.example/../{file}"],
    ["a reserved character", "https://cdn.example/a%20b/{file}"],
  ])("rejects %s", (_label, url) => {
    expect(() => parseUrlTemplate(url)).toThrow(ResolverTemplateError);
  });
});

describe("parseKeyTemplate", () => {
  it("accepts a bare and a prefixed key", () => {
    expect(parseKeyTemplate("{key}").placeholders).toEqual(["key"]);
    expect(parseKeyTemplate("originals/{tenant}/{key}").placeholders).toEqual(["tenant", "key"]);
  });

  it.each([
    ["a leading slash", "/{key}"],
    ["a trailing slash", "{key}/"],
    ["no placeholder", "originals/static"],
    ["an empty string", ""],
  ])("rejects %s", (_label, template) => {
    expect(() => parseKeyTemplate(template)).toThrow(ResolverTemplateError);
  });
});

describe("parseSourceReference", () => {
  it("names the Source ID after the resolver and the reference", () => {
    expect(parseSourceReference(uploadThing, ["ernesta_prod", "file_9"])).toEqual({
      sourceId: "ut/ernesta_prod/file_9",
      values: ["ernesta_prod", "file_9"],
    });
    expect(parseSourceReference(media, ["AbC123.jpg"])?.sourceId).toBe("media/AbC123.jpg");
    expect(resolverSourceId("lw", ["tok"])).toBe("lw/tok");
  });

  it("takes the v1 project and file pair for a retired UploadThing resolver", () => {
    const legacy = { id: "u", type: "uploadthing", allowedProjectIds: ["p1"] } as const;
    expect(resolverPlaceholders(legacy)).toEqual(["project", "file"]);
    expect(parseSourceReference(legacy, ["p1", "f"])?.sourceId).toBe("u/p1/f");
    expect(parseSourceReference(legacy, ["p2", "f"])).toBeUndefined();
  });

  it.each([
    ["too few segments", uploadThing, ["ernesta_prod"]],
    ["too many segments", prefix, ["a", "b"]],
    ["a value outside the allowed list", uploadThing, ["other", "file_9"]],
    ["a slash inside a segment", prefix, ["a/b"]],
    ["a dot segment", prefix, [".."]],
    ["a single dot", prefix, ["."]],
    ["an empty segment", prefix, [""]],
    ["a space", prefix, ["a b"]],
    ["a percent sign", prefix, ["a%2Fb"]],
    ["an overlong segment", prefix, ["a".repeat(513)]],
  ])("rejects %s", (_label, resolver, segments) => {
    expect(parseSourceReference(resolver, segments)).toBeUndefined();
  });
});

describe("expansion", () => {
  it("inserts hostname labels raw and encodes path values once", () => {
    expect(expandTemplateResolver(uploadThing, ["ernesta_prod", "file_9.jpg"])).toBe(
      "https://ernesta_prod.ufs.sh/f/file_9.jpg",
    );
    expect(expandTemplateResolver(prefix, ["tok-1"])).toBe("https://latch.example/cdn/v1/tok-1");
  });

  it("addresses S3 objects in path or virtual-hosted style", () => {
    expect(expandS3Resolver(media, ["AbC123"])).toEqual({
      key: "originals/AbC123",
      url: "https://account.r2.cloudflarestorage.com/ernesta-images/originals/AbC123",
    });
    expect(expandS3Resolver({ ...media, pathStyle: false }, ["AbC123"]).url).toBe(
      "https://ernesta-images.account.r2.cloudflarestorage.com/originals/AbC123",
    );
  });

  it("refuses the wrong number of values", () => {
    expect(() => expandTemplateResolver(uploadThing, ["only-one"])).toThrow(ResolverTemplateError);
  });
});

describe("allowlist prefixes", () => {
  it("names the literal prefix under every allowed hostname value", () => {
    expect(resolverOriginPrefixes(uploadThing)).toEqual([
      "https://ernesta_prod.ufs.sh/f",
      "https://ernesta-staging.ufs.sh/f",
    ]);
    expect(resolverOriginPrefixes(prefix)).toEqual(["https://latch.example/cdn/v1"]);
    expect(resolverOriginPrefixes(media)).toEqual([
      "https://account.r2.cloudflarestorage.com/ernesta-images/originals",
    ]);
    expect(resolverOriginPrefixes({ ...media, keyTemplate: "{key}", pathStyle: false })).toEqual([
      "https://ernesta-images.account.r2.cloudflarestorage.com/",
    ]);
  });

  it("passes when every prefix sits inside the Space origins and fails otherwise", () => {
    const rules = [
      { origin: "https://ernesta_prod.ufs.sh", pathPrefix: "/f" },
      { origin: "https://ernesta-staging.ufs.sh" },
      { origin: "https://account.r2.cloudflarestorage.com", pathPrefix: "/ernesta-images" },
    ];
    expect(() => validateResolverOrigins(uploadThing, rules)).not.toThrow();
    expect(() => validateResolverOrigins(media, rules)).not.toThrow();
    expect(() => validateResolverOrigins(prefix, rules)).toThrow(
      expect.objectContaining({ code: "locator_not_allowed" }),
    );
    expect(() =>
      validateResolverOrigins(uploadThing, [{ origin: "https://ernesta_prod.ufs.sh" }]),
    ).toThrow(expect.objectContaining({ code: "locator_not_allowed" }));
  });

  it("does not let a rule narrower than the literal prefix pass", () => {
    const open: TemplateResolverPolicy = {
      id: "open",
      type: "template",
      url: "https://cdn.example/{key}",
      placeholders: { key: {} },
    };
    expect(() =>
      validateResolverOrigins(open, [{ origin: "https://cdn.example", pathPrefix: "/x" }]),
    ).toThrow(expect.objectContaining({ code: "locator_not_allowed" }));
    expect(() =>
      validateResolverOrigins(prefix, [
        { origin: "https://latch.example", pathPrefix: "/cdn/v1/x" },
      ]),
    ).toThrow(expect.objectContaining({ code: "locator_not_allowed" }));
    expect(() =>
      validateResolverOrigins(media, [
        {
          origin: "https://account.r2.cloudflarestorage.com",
          pathPrefix: "/ernesta-images/originals/x",
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "locator_not_allowed" }));
    expect(() => validateResolverOrigins(open, [{ origin: "https://cdn.example" }])).not.toThrow();
  });
});
