import { describe, expect, it } from "vitest";
import { canonicalDeliveryQuery, parseDeliveryQuery } from "./delivery-query.js";

const policy = { qualities: [30, 50, 75], defaultQuality: 75 };
const publicRoute = { token: "forbidden" } as const;
const privateRoute = { token: "required" } as const;

function parse(search: string, options = publicRoute) {
  return parseDeliveryQuery(new URLSearchParams(search), policy, options);
}

describe("parseDeliveryQuery", () => {
  it("selects Source Delivery when there is no query", () => {
    expect(parse("")).toEqual({ operation: { type: "source_delivery" } });
  });

  it("selects Image Optimization from w and q and reports canonical form", () => {
    expect(parse("w=640&q=75")).toEqual({
      operation: { type: "image_optimization", width: 640, quality: 75, isCanonical: true },
    });
    expect(parse("w=639").operation).toEqual({
      type: "image_optimization",
      width: 640,
      quality: 75,
      isCanonical: false,
    });
  });

  it("selects the Master Preview from preview with w", () => {
    expect(parse("preview=video&w=640&q=75").operation).toEqual({
      type: "master_preview",
      kind: "video",
      width: 640,
      quality: 75,
      isCanonical: true,
    });
    expect(parse("w=640&preview=pdf&q=75").operation).toMatchObject({ kind: "pdf" });
  });

  it("returns the token only on a private route", () => {
    expect(parse("w=640&q=75&token=v2.k.iv.ct", privateRoute)).toEqual({
      operation: { type: "image_optimization", width: 640, quality: 75, isCanonical: true },
      token: "v2.k.iv.ct",
    });
    expect(parse("token=v2.k.iv.ct", privateRoute)).toEqual({
      operation: { type: "source_delivery" },
      token: "v2.k.iv.ct",
    });
  });

  it("fails a private route closed without a token", () => {
    expect(() => parse("w=640&q=75", privateRoute)).toThrow(
      expect.objectContaining({ code: "capability_malformed" }),
    );
    expect(() => parse("token=", privateRoute)).toThrow(
      expect.objectContaining({ code: "capability_malformed" }),
    );
  });

  it.each([
    ["q without w", "q=75"],
    ["preview without w", "preview=video"],
    ["an unknown preview kind", "preview=gif&w=640"],
    ["a duplicated preview", "preview=video&preview=pdf&w=640"],
    ["a duplicated width", "w=640&w=750"],
    ["an unknown parameter", "w=640&format=avif"],
    ["a token on a public route", "w=640&token=x"],
    ["a malformed width", "w=abc"],
  ])("rejects %s", (_label, search) => {
    expect(() => parse(search)).toThrow(expect.objectContaining({ code: "query_invalid" }));
  });
});

describe("canonicalDeliveryQuery", () => {
  it("orders preview, w, q and is empty for Source Delivery", () => {
    expect(canonicalDeliveryQuery({ type: "source_delivery" })).toBe("");
    expect(
      canonicalDeliveryQuery({
        type: "image_optimization",
        width: 640,
        quality: 75,
        isCanonical: false,
      }),
    ).toBe("w=640&q=75");
    expect(
      canonicalDeliveryQuery({
        type: "master_preview",
        kind: "pdf",
        width: 320,
        quality: 50,
        isCanonical: false,
      }),
    ).toBe("preview=pdf&w=320&q=50");
  });
});
