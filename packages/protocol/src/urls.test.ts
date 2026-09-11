import { describe, expect, it } from "vitest";
import { buildV2DeliveryUrl, buildV2PreviewJobUrl, buildV2SourcePurgeUrl } from "./urls.js";

describe("v2 URL builders", () => {
  it("builds the delivery path with one encoded segment per reference value", () => {
    expect(buildV2DeliveryUrl("ernesta", "media", ["AbC123"])).toBe("/v2/ernesta/media/AbC123");
    expect(() => buildV2DeliveryUrl("ernesta", "Media/x", ["AbC123"])).toThrow(TypeError);
    expect(() => buildV2DeliveryUrl("ernesta", "", ["AbC123"])).toThrow(TypeError);
    expect(
      buildV2DeliveryUrl("ernesta", "ut", ["ernesta_prod", "file_9.jpg"], { width: 640 }),
    ).toBe("/v2/ernesta/ut/ernesta_prod/file_9.jpg?w=640");
  });

  it("orders the query preview, w, q, token", () => {
    expect(
      buildV2DeliveryUrl("ernesta", "media", ["tour.mp4"], {
        token: "v2.k.iv.ct",
        quality: 75,
        width: 640,
        preview: "video",
      }),
    ).toBe("/v2/ernesta/media/tour.mp4?preview=video&w=640&q=75&token=v2.k.iv.ct");
  });

  it("refuses combinations the Edge would reject", () => {
    expect(() => buildV2DeliveryUrl("ernesta", "media", [])).toThrow(TypeError);
    expect(() => buildV2DeliveryUrl("ernesta", "media", ["a"], { quality: 75 })).toThrow(TypeError);
    expect(() => buildV2DeliveryUrl("ernesta", "media", ["a"], { preview: "pdf" })).toThrow(
      TypeError,
    );
    for (const segment of ["", "file one", "..", ".", "a/b", "a%2Fb", "a".repeat(513)]) {
      expect(() => buildV2DeliveryUrl("ernesta", "media", [segment])).toThrow(TypeError);
    }
  });

  it("encodes a resolver Source ID as one segment on the Control routes", () => {
    expect(buildV2PreviewJobUrl("ernesta", "media/tour.mp4", "video")).toBe(
      "/v2/spaces/ernesta/sources/media%2Ftour.mp4/previews/video",
    );
    expect(buildV2SourcePurgeUrl("ernesta", "media/AbC123")).toBe(
      "/v2/spaces/ernesta/sources/media%2FAbC123/purge",
    );
  });
});
