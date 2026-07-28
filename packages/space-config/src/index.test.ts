import { describe, expect, it } from "vitest";
import { getSpacePolicy, SPACES } from "./index.js";

describe("Space policies", () => {
  it("locks reviewed Space policies and ignores unknown names", () => {
    expect(SPACES.ernesta).toMatchObject({
      id: "ernesta",
      routeClass: "public",
      qualities: [30, 50, 75],
      defaultQuality: 75,
      allowedSourceOrigins: [
        { origin: "https://8w0z32yftd.ufs.sh", pathPrefix: "/f" },
        { origin: "https://rrsku8h9ue.ufs.sh", pathPrefix: "/f" },
      ],
    });
    expect(SPACES.ernesta.resolvers[0]?.allowedProjectIds).toEqual(["8w0z32yftd", "rrsku8h9ue"]);
    expect(SPACES["pane-view"]).toEqual({
      id: "pane-view",
      routeClass: "private",
      qualities: [30, 75, 80],
      defaultQuality: 75,
      allowedSourceOrigins: [
        {
          origin: "https://t3.storageapi.dev",
          pathPrefix: "/balanced-wrap-ocyiwwexhao",
        },
      ],
      resolvers: [],
    });
    expect(getSpacePolicy("toString")).toBeUndefined();
    expect(getSpacePolicy("unknown")).toBeUndefined();
  });
});
