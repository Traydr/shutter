import { describe, expect, it } from "vitest";
import {
  buildPreviewJobUrl,
  buildPrivateMasterUrl,
  buildPrivateSourceUrl,
  buildPublicLocatedSourceUrl,
  buildPublicMasterUrl,
  buildPublicResolverUrl,
  buildSourcePurgeUrl,
} from "./urls.js";

const rendition = { width: 640, quality: 75 };

describe("v1 URL builders", () => {
  it("builds all canonical routes and encodes each opaque segment once", () => {
    expect(buildPublicResolverUrl("ernesta", "uploadthing", "project/file one", rendition)).toBe(
      "/v1/public/ernesta/resolver/uploadthing/project%2Ffile%20one?w=640&q=75",
    );
    expect(
      buildPublicLocatedSourceUrl("ernesta", "source/one", "capability.token", rendition),
    ).toBe("/v1/public/ernesta/located/source%2Fone/capability.token?w=640&q=75");
    expect(buildPublicMasterUrl("ernesta", "video", "source/one", rendition)).toBe(
      "/v1/public/ernesta/master/video/source%2Fone?w=640&q=75",
    );
    expect(buildPrivateSourceUrl("pane-view", "capability.token", rendition)).toBe(
      "/v1/private/pane-view/source/capability.token?w=640&q=75",
    );
    expect(buildPrivateMasterUrl("pane-view", "capability.token", rendition)).toBe(
      "/v1/private/pane-view/master/capability.token?w=640&q=75",
    );
    expect(buildPreviewJobUrl("pane-view", "source/one", "pdf")).toBe(
      "/v1/spaces/pane-view/sources/source%2Fone/previews/pdf",
    );
    expect(buildSourcePurgeUrl("pane-view", "source/one")).toBe(
      "/v1/spaces/pane-view/sources/source%2Fone/purge",
    );
  });
});
