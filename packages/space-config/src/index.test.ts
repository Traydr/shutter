import { describe, expect, it } from "vitest";
import { getSpacePolicy, SPACES } from "./index.js";

describe("Space policies", () => {
  it("locks Ernesta to its public quality policy and fail-closed resolver", () => {
    expect(SPACES.ernesta).toMatchObject({
      id: "ernesta",
      routeClass: "public",
      qualities: [30, 50, 75],
      defaultQuality: 75,
      allowedSourceOrigins: [],
    });
    expect(SPACES.ernesta.resolvers[0]?.allowedProjectIds).toEqual([]);
  });

  it("locks Pane View to its private quality policy and empty origin allowlist", () => {
    expect(SPACES["pane-view"]).toEqual({
      id: "pane-view",
      routeClass: "private",
      qualities: [30, 75, 80],
      defaultQuality: 75,
      allowedSourceOrigins: [],
      resolvers: [],
    });
  });

  it("does not return inherited or unknown Space names", () => {
    expect(getSpacePolicy("toString")).toBeUndefined();
    expect(getSpacePolicy("unknown")).toBeUndefined();
  });
});
