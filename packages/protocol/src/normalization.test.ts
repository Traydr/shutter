import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { QueryError } from "./errors.js";
import { normalizeQuality, normalizeRenditionQuery, normalizeWidth } from "./normalization.js";

const policy = { qualities: [30, 50, 75] as const, defaultQuality: 75 };

describe("rendition normalization", () => {
  it.each([
    [24, 24],
    [1, 320],
    [23, 320],
    [25, 320],
    [320, 320],
    [321, 640],
    [3839, 3840],
    [3840, 3840],
    [9000, 3840],
  ])("normalizes width %i to %i", (requested, expected) => {
    expect(normalizeWidth(requested)).toBe(expected);
  });

  it("normalizes quality to the nearest permitted value and resolves ties upward", () => {
    expect(normalizeQuality(40, policy.qualities)).toBe(50);
    expect(normalizeQuality(62, policy.qualities)).toBe(50);
    expect(normalizeQuality(63, policy.qualities)).toBe(75);
    expect(normalizeQuality(100, policy.qualities)).toBe(75);
  });

  it("defaults only quality and reports whether the request is canonical", () => {
    expect(Effect.runSync(normalizeRenditionQuery(new URLSearchParams("w=640"), policy))).toEqual({
      width: 640,
      quality: 75,
      isCanonical: false,
    });
    expect(
      Effect.runSync(normalizeRenditionQuery(new URLSearchParams("w=640&q=75"), policy)),
    ).toEqual({
      width: 640,
      quality: 75,
      isCanonical: true,
    });
    expect(
      Effect.runSync(normalizeRenditionQuery(new URLSearchParams("w=500&q=74"), policy)),
    ).toEqual({
      width: 640,
      quality: 75,
      isCanonical: false,
    });
  });

  it.each([
    "",
    "q=75",
    "w=0",
    "w=-1",
    "w=1.5",
    "w=%20640",
    "w=640&w=750",
    "w=640&q=75&q=50",
    "w=640&h=480",
  ])("rejects invalid query %s", (query) => {
    expect(() =>
      Effect.runSync(normalizeRenditionQuery(new URLSearchParams(query), policy)),
    ).toThrow(QueryError);
  });
});
