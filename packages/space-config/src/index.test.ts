import { describe, expect, it } from "vitest";
import { getSpacePolicy, SPACES } from "./index.js";

describe("Space policies", () => {
  it("locks reviewed Space policies and ignores unknown names", () => {
    expect(SPACES["demo-public"]).toMatchObject({
      id: "demo-public",
      routeClass: "public",
      qualities: [30, 50, 75],
      defaultQuality: 75,
      allowedSourceOrigins: [
        { origin: "https://demo-project-1.ufs.sh", pathPrefix: "/f" },
        { origin: "https://demo-project-2.ufs.sh", pathPrefix: "/f" },
      ],
    });
    expect(SPACES["demo-public"].resolvers[0]?.allowedProjectIds).toEqual([
      "demo-project-1",
      "demo-project-2",
    ]);
    expect(SPACES["demo-private"]).toEqual({
      id: "demo-private",
      routeClass: "private",
      qualities: [30, 75, 80],
      defaultQuality: 75,
      allowedSourceOrigins: [
        {
          origin: "https://objects.example.com",
          pathPrefix: "/demo-private-bucket",
        },
      ],
      resolvers: [],
    });
    expect(getSpacePolicy("toString")).toBeUndefined();
    expect(getSpacePolicy("unknown")).toBeUndefined();
  });
});
