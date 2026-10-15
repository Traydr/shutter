import { describe, expect, it } from "vitest";
import { bearerCheck } from "./origin-auth.js";

describe("bearerCheck", () => {
  it("compares against whichever token is configured at the time", () => {
    const first = "a".repeat(32);
    const second = "b".repeat(32);
    let configured = first;
    const authorized = bearerCheck(() => configured);

    expect(authorized(`Bearer ${first}`)).toBe(true);
    expect(authorized(`Bearer ${second}`)).toBe(false);
    configured = second;
    expect(authorized(`Bearer ${second}`)).toBe(true);
    expect(authorized(`Bearer ${first}`)).toBe(false);
    configured = first;
    expect(authorized(`Bearer ${first}`)).toBe(true);
  });

  it("fails closed without a usable configured token or header", () => {
    const token = "a".repeat(32);

    expect(bearerCheck(() => undefined)(`Bearer ${token}`)).toBe(false);
    expect(bearerCheck(() => "short")("Bearer short")).toBe(false);
    expect(bearerCheck(() => token)(undefined)).toBe(false);
    expect(bearerCheck(() => token)(`Basic ${token}`)).toBe(false);
  });
});
