import { describe, expect, it } from "vitest";
import { getSpacePolicy, SPACES } from "./index.js";

describe("Space policies", () => {
  it("locks Ernesta to its reviewed public quality and UploadThing policy", () => {
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
    expect(SPACES.ernesta.resolvers[0]?.allowedProjectIds).toEqual([
      "8w0z32yftd",
      "rrsku8h9ue",
    ]);
  });

  it("locks Pane View to its reviewed private source origins", () => {
    expect(SPACES["pane-view"]).toEqual({
      id: "pane-view",
      routeClass: "private",
      qualities: [30, 75, 80],
      defaultQuality: 75,
      allowedSourceOrigins: [
        { origin: "https://t3.storageapi.dev" },
        { origin: "https://pane-view.traydr.dev" },
      ],
      resolvers: [],
    });
  });

  it("does not return inherited or unknown Space names", () => {
    expect(getSpacePolicy("toString")).toBeUndefined();
    expect(getSpacePolicy("unknown")).toBeUndefined();
  });
});
