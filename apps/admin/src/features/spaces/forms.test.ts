import { describe, expect, it } from "vitest";
import {
  allowedFor,
  createSpaceBody,
  emptyResolverFields,
  FormInputError,
  hostnamePlaceholders,
  placeholderNames,
  policyFields,
  policyUpdateBody,
  referenceSegments,
  requestPattern,
  resolverBody,
  resolverFields,
  withAllowed,
} from "./forms.js";

describe("space forms", () => {
  it("round-trips policy fields and assembles a create body", () => {
    const fields = policyFields({
      qualities: [60, 75],
      defaultQuality: 75,
      allowedSourceOrigins: [
        { origin: "https://uploads.example.test" },
        { origin: "https://objects.example.test", pathPrefix: "/bucket" },
      ],
    });
    expect(fields).toEqual({
      qualities: "60, 75",
      defaultQuality: "75",
      allowedSourceOrigins: "https://uploads.example.test\nhttps://objects.example.test/bucket",
    });
    expect(createSpaceBody({ ...fields, id: " ernesta ", routeClass: "public" })).toEqual({
      id: "ernesta",
      routeClass: "public",
      qualities: [60, 75],
      defaultQuality: 75,
      allowedSourceOrigins: [
        { origin: "https://uploads.example.test" },
        { origin: "https://objects.example.test", pathPrefix: "/bucket" },
      ],
    });
    expect(() => policyUpdateBody({ ...fields, allowedSourceOrigins: "not a url" })).toThrow(
      FormInputError,
    );
    expect(policyUpdateBody({ ...fields, qualities: "60,,90 " }).qualities).toEqual([60, 90]);
  });

  it("assembles a template resolver with placeholders from the URL and the allowed lines", () => {
    const body = resolverBody({
      id: "media",
      kind: "template",
      url: "https://{project}.ufs.sh/f/{file}",
      allowed: "project=abc, def\n",
      endpoint: "",
      region: "",
      bucket: "",
      pathStyle: true,
      keyTemplate: "",
      accessKeyId: "",
      secretAccessKey: "",
    });
    expect(body).toEqual({
      resolver: {
        id: "media",
        type: "template",
        url: "https://{project}.ufs.sh/f/{file}",
        placeholders: { project: { allowed: ["abc", "def"] }, file: {} },
      },
    });
    expect(
      resolverFields({
        id: "media",
        type: "template",
        url: "https://{project}.ufs.sh/f/{file}",
        placeholders: { project: { allowed: ["abc"] }, file: {} },
      }),
    ).toMatchObject({ kind: "template", allowed: "project=abc" });
  });

  it("assembles an S3 resolver and requires both halves of a credential", () => {
    const fields = {
      id: "originals",
      kind: "s3" as const,
      url: "",
      allowed: "",
      endpoint: "https://objects.example.test",
      region: "",
      bucket: "bucket",
      pathStyle: true,
      keyTemplate: "originals/{key}",
      accessKeyId: "AKIA",
      secretAccessKey: "",
    };
    expect(() => resolverBody(fields)).toThrow(FormInputError);
    expect(resolverBody({ ...fields, secretAccessKey: "s" })).toEqual({
      resolver: {
        id: "originals",
        type: "s3",
        endpoint: "https://objects.example.test",
        region: "auto",
        bucket: "bucket",
        pathStyle: true,
        keyTemplate: "originals/{key}",
      },
      credential: { accessKeyId: "AKIA", secretAccessKey: "s" },
    });
    expect(resolverBody({ ...fields, accessKeyId: "" }).credential).toBeUndefined();
  });

  it("splits a sample reference and refuses empty segments", () => {
    expect(referenceSegments("abc / photo.jpg")).toEqual(["abc", "photo.jpg"]);
    expect(() => referenceSegments("abc//x")).toThrow(FormInputError);
  });
});

describe("placeholder helpers", () => {
  it("finds placeholders and which sit in the hostname", () => {
    expect(placeholderNames("https://{project}.ufs.sh/f/{file}")).toEqual(["project", "file"]);
    expect(hostnamePlaceholders("https://{project}.ufs.sh/f/{file}")).toEqual(["project"]);
    expect(hostnamePlaceholders("https://cdn.example/{a}/{b}")).toEqual([]);
    expect(hostnamePlaceholders("not a url {x}")).toEqual([]);
  });

  it("edits one placeholder's values inside the allowed lines", () => {
    const allowed = "project=abc,def\nfile=one";
    expect(allowedFor(allowed, "project")).toBe("abc,def");
    expect(allowedFor(allowed, "missing")).toBe("");
    expect(withAllowed(allowed, "file", "two, three")).toBe("project=abc,def\nfile=two, three");
    expect(withAllowed(allowed, "file", "  ")).toBe("project=abc,def");
    expect(withAllowed("", "project", "abc")).toBe("project=abc");
  });

  it("drops a value list for a placeholder the URL no longer has", () => {
    const fields = emptyResolverFields("template");
    fields.id = "cdn";
    fields.url = "https://uploads.example.test/f/{folder}/{file}";
    fields.allowed = "project=abc,def\nfolder=a";
    expect(resolverBody(fields).resolver).toEqual({
      id: "cdn",
      type: "template",
      url: "https://uploads.example.test/f/{folder}/{file}",
      placeholders: { folder: { allowed: ["a"] }, file: {} },
    });
  });

  it("derives the request pattern from the editor's fields", () => {
    const template = emptyResolverFields("template");
    template.id = "uploadthing";
    template.url = "https://{project}.ufs.sh/f/{file}";
    expect(requestPattern(template)).toBe("uploadthing/{project}/{file}");
    const s3 = emptyResolverFields("s3");
    s3.keyTemplate = "originals/{a}/{b}";
    expect(requestPattern(s3)).toBe("…/{a}/{b}");
  });
});
