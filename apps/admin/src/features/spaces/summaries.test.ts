import type { AdminSpaceDetail } from "@shutter/admin-api";
import { describe, expect, it } from "vitest";
import {
  calendarDate,
  deployment,
  edgeSentence,
  keyRotation,
  overviewSpaceState,
  relativeTime,
  resolverDestination,
  spaceState,
} from "./summaries.js";

const NOW = Date.parse("2026-09-13T09:30:00Z");

function detail(overrides: Partial<AdminSpaceDetail> = {}): AdminSpaceDetail {
  return {
    generation: 18,
    space: {
      policy: {
        id: "ernesta",
        routeClass: "public",
        qualities: [30, 75],
        defaultQuality: 75,
        allowedSourceOrigins: [{ origin: "https://8w0z32yftd.ufs.sh", pathPrefix: "/f" }],
        resolvers: [
          {
            id: "media",
            type: "s3",
            endpoint: "https://t3.storageapi.dev",
            region: "ams",
            bucket: "ernesta-images",
            pathStyle: false,
            keyTemplate: "{key}",
          },
        ],
      },
      status: "active",
      createdAt: "2026-08-13T18:11:08.000Z",
      updatedAt: "2026-09-12T08:42:13.000Z",
    },
    apiTokens: [],
    capabilityKeys: [{ id: 4, keyId: "k-2026-08", acceptedAt: "2026-08-13T18:30:00.000Z" }],
    resolverCredentials: [
      { resolverId: "media", accessKeyId: "AKIA", updatedAt: "2026-09-10T14:12:00.000Z" },
    ],
    coverage: { derivedValue: "https://8w0z32yftd.ufs.sh/f", uncovered: [] },
    edgeBaseUrl: "https://shutter-edge.traydr.dev",
    ...overrides,
  };
}

describe("space state", () => {
  it("is ready when nothing needs the operator", () => {
    expect(spaceState(detail())).toEqual({ tone: "ok", text: "Ready" });
  });

  it("names the most urgent thing first", () => {
    const base = detail();
    expect(
      spaceState(detail({ coverage: { derivedValue: "", uncovered: ["https://cdn.example/x"] } })),
    ).toEqual({ tone: "warn", text: "cdn.example/x isn't deployed yet" });
    expect(spaceState(detail({ resolverCredentials: [] }))).toEqual({
      tone: "warn",
      text: "media has no credential yet",
    });
    expect(spaceState(detail({ capabilityKeys: [] }))).toEqual({
      tone: "warn",
      text: "No Capability Key yet",
    });
    expect(
      spaceState(
        detail({
          capabilityKeys: [
            ...base.capabilityKeys,
            { id: 7, keyId: "k-2026-09", acceptedAt: "2026-09-11T16:05:00.000Z" },
          ],
        }),
      ),
    ).toEqual({ tone: "warn", text: "Key rotation in progress" });
    expect(spaceState(detail({ space: { ...base.space, status: "decommissioned" } })).tone).toBe(
      "off",
    );
  });

  it("tells the operator which key to disable during a rotation", () => {
    const base = detail();
    const rotation = keyRotation(
      detail({
        capabilityKeys: [
          ...base.capabilityKeys,
          { id: 7, keyId: "k-2026-09", acceptedAt: "2026-09-11T16:05:00.000Z" },
        ],
      }),
    );
    expect(rotation.tone).toBe("warn");
    expect(rotation.text).toContain("mints with k-2026-09");
    expect(rotation.text).toContain("disable k-2026-08");
    expect(keyRotation(detail())).toEqual({ tone: "ok", text: "One key accepted: k-2026-08." });
  });

  it("reads coverage from the overview alone", () => {
    const { space } = detail();
    expect(overviewSpaceState(space, [])).toEqual({ tone: "ok", text: "Ready" });
    expect(overviewSpaceState(space, ["https://8w0z32yftd.ufs.sh/f"])).toEqual({
      tone: "warn",
      text: "8w0z32yftd.ufs.sh/f isn't deployed yet",
    });
    expect(deployment(detail()).tone).toBe("ok");
    expect(
      deployment(
        detail({ coverage: { derivedValue: "", uncovered: ["https://8w0z32yftd.ufs.sh/f"] } }),
      ),
    ).toEqual({ tone: "warn", text: "One of 1 isn't in the deployed allowlist yet." });
  });
});

describe("sentences", () => {
  it("describes the Edge without a generation number", () => {
    expect(edgeSentence({ generation: 18, edgeRefresh: undefined })).toEqual({
      tone: "warn",
      text: "The Edge hasn't reported a refresh yet.",
    });
    expect(
      edgeSentence({ generation: 18, edgeRefresh: { generation: 18, refreshedAt: "x" } }).tone,
    ).toBe("ok");
    expect(
      edgeSentence({ generation: 19, edgeRefresh: { generation: 18, refreshedAt: "x" } }).tone,
    ).toBe("warn");
  });

  it("renders destinations as one template", () => {
    expect(
      resolverDestination(
        detail().space.policy.resolvers[0] ?? {
          type: "template",
          id: "",
          url: "",
          placeholders: {},
        },
      ),
    ).toBe("ernesta-images.t3.storageapi.dev/{key}");
    expect(
      resolverDestination({
        id: "originals",
        type: "s3",
        endpoint: "https://t3.storageapi.dev",
        region: "ams",
        bucket: "bucket",
        pathStyle: true,
        keyTemplate: "originals/{a}/{b}",
      }),
    ).toBe("t3.storageapi.dev/bucket/originals/{a}/{b}");
  });

  it("formats times in words", () => {
    expect(relativeTime("2026-09-13T09:14:00Z", NOW)).toBe("16 minutes ago");
    expect(relativeTime("2026-09-13T09:29:50Z", NOW)).toBe("1 minute ago");
    expect(relativeTime("2026-09-12T22:40:00Z", NOW)).toBe("11 hours ago");
    expect(relativeTime("2026-08-13T18:11:00Z", NOW)).toBe("31 days ago");
    expect(calendarDate("2026-08-13T18:11:08.000Z")).toBe("Aug 13, 2026");
  });
});
