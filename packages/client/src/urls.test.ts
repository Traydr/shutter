import { describe, expect, it } from "vitest";
import { deliveryUrl, isDeliveryUrl, sourceIdFor, transformDeliveryUrl } from "./urls.js";

const EDGE = "https://edge.example.test";

describe("v2 delivery URLs", () => {
  it("builds an absolute or relative URL from a resolver and reference", () => {
    expect(deliveryUrl({ spaceId: "ernesta", resolverId: "media", reference: "AbC123" })).toBe(
      "/v2/ernesta/media/AbC123",
    );
    expect(
      deliveryUrl(
        { edgeBaseUrl: EDGE, spaceId: "ernesta", resolverId: "ut", reference: ["proj", "f_9"] },
        { width: 640, quality: 75 },
      ),
    ).toBe(`${EDGE}/v2/ernesta/ut/proj/f_9?w=640&q=75`);
    expect(() =>
      deliveryUrl({ spaceId: "ernesta", resolverId: "media", reference: "a/b" }),
    ).toThrow(TypeError);
  });

  it("names the Source ID the job and purge endpoints take", () => {
    expect(sourceIdFor("media", "AbC123")).toBe("media/AbC123");
    expect(sourceIdFor("ut", ["proj", "f_9"])).toBe("ut/proj/f_9");
    expect(() => sourceIdFor("media", "..")).toThrow(TypeError);
    expect(() => sourceIdFor("media", [])).toThrow(TypeError);
    expect(() => sourceIdFor("", "AbC123")).toThrow(TypeError);
    expect(() => sourceIdFor("a/b", "AbC123")).toThrow(TypeError);
    expect(() => deliveryUrl({ spaceId: "ernesta", resolverId: "Media", reference: "k" })).toThrow(
      TypeError,
    );
  });

  it("recognizes only v2 URLs on the configured edge", () => {
    expect(isDeliveryUrl(`${EDGE}/v2/ernesta/media/AbC123`, EDGE)).toBe(true);
    expect(isDeliveryUrl("/v2/ernesta/media/AbC123", EDGE)).toBe(true);
    expect(isDeliveryUrl("/v1/public/ernesta/located/a/b", EDGE)).toBe(false);
    expect(isDeliveryUrl(`${EDGE}/v1/public/ernesta/located/a/b`, EDGE)).toBe(false);
    expect(isDeliveryUrl("https://elsewhere.test/v2/ernesta/media/AbC123", EDGE)).toBe(false);
    expect(isDeliveryUrl("data:image/png;base64,AA", EDGE)).toBe(false);
  });

  it("rewrites width and quality and keeps preview and token in place", () => {
    const base = `${EDGE}/v2/ernesta/media/tour.mp4`;
    expect(transformDeliveryUrl(base, EDGE, { width: 640, quality: 75 })).toBe(
      `${base}?w=640&q=75`,
    );
    expect(
      transformDeliveryUrl(`${base}?preview=video&w=320&q=30&token=v2.k.iv.ct`, EDGE, {
        width: 1280,
        quality: 50,
      }),
    ).toBe(`${base}?preview=video&w=1280&q=50&token=v2.k.iv.ct`);
    expect(transformDeliveryUrl(`${base}?w=640&q=75`, EDGE, {})).toBe(`${base}?w=640&q=75`);
    expect(transformDeliveryUrl(`${base}?preview=video&w=640&q=75`, EDGE, {})).toBe(
      `${base}?preview=video&w=640&q=75`,
    );
    expect(transformDeliveryUrl(`${base}?preview=pdf&w=640`, EDGE, { quality: 50 })).toBe(
      `${base}?preview=pdf&w=640&q=50`,
    );
    expect(transformDeliveryUrl(base, EDGE, { quality: 50 })).toBe(base);
    expect(
      transformDeliveryUrl("/v2/ernesta/media/tour.mp4", EDGE, { width: 640, quality: 75 }),
    ).toBe("/v2/ernesta/media/tour.mp4?w=640&q=75");
    expect(transformDeliveryUrl("/v2/ernesta/media/x?w=320&q=75", EDGE, { width: 1280 })).toBe(
      "/v2/ernesta/media/x?w=1280&q=75",
    );
    expect(transformDeliveryUrl("https://elsewhere.test/x.jpg", EDGE, { width: 640 })).toBe(
      "https://elsewhere.test/x.jpg",
    );
  });

  it("keeps a private token only while the operation stays the same", () => {
    const base = `${EDGE}/v2/ernesta/media/x`;
    expect(transformDeliveryUrl(`${base}?w=320&q=75&token=t`, EDGE, { width: 640 })).toBe(
      `${base}?w=640&q=75&token=t`,
    );
    expect(transformDeliveryUrl(`${base}?token=t`, EDGE, { width: 640, quality: 75 })).toBe(
      `${base}?w=640&q=75`,
    );
    expect(transformDeliveryUrl(`${base}?token=t`, EDGE, {})).toBe(`${base}?token=t`);
  });
});
