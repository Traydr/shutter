import { describe, expect, it } from "vitest";
import { parseSpacePolicy, SpacePolicyValidationError } from "./space-policy.js";

const validPublicPolicy = {
  id: "example-public",
  routeClass: "public",
  qualities: [30, 50, 75],
  defaultQuality: 75,
  allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/media/" }],
  resolvers: [{ id: "uploadthing", type: "uploadthing", allowedProjectIds: ["project_one"] }],
};

describe("parseSpacePolicy", () => {
  it("parses and normalizes the public Space policy", () => {
    expect(parseSpacePolicy(validPublicPolicy)).toEqual({
      ...validPublicPolicy,
      allowedSourceOrigins: [{ origin: "https://sources.example.com", pathPrefix: "/media" }],
    });
  });

  it("accepts a private Space without Source Resolvers", () => {
    expect(
      parseSpacePolicy({
        ...validPublicPolicy,
        id: "example-private",
        routeClass: "private",
        resolvers: [],
      }),
    ).toMatchObject({ id: "example-private", routeClass: "private", resolvers: [] });
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
    ["private resolver", { ...validPublicPolicy, routeClass: "private" }],
    ["quality outside range", { ...validPublicPolicy, qualities: [0, 75] }],
    ["missing default quality", { ...validPublicPolicy, defaultQuality: 80 }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseSpacePolicy(input)).toThrow(SpacePolicyValidationError);
  });
});
