import { describe, expect, it } from "vitest";
import { createLoginThrottle } from "./login-throttle.js";

describe("login throttle", () => {
  it("locks a key after five failures inside the window and forgets it after", () => {
    const clock = { now: 1_000 };
    const throttle = createLoginThrottle(() => clock.now);
    for (let attempt = 0; attempt < 4; attempt += 1) throttle.recordFailure("1.2.3.4");
    expect(throttle.isThrottled("1.2.3.4")).toBe(false);
    throttle.recordFailure("1.2.3.4");
    expect(throttle.isThrottled("1.2.3.4")).toBe(true);
    expect(throttle.isThrottled("5.6.7.8")).toBe(false);
    clock.now += 5 * 60 * 1_000;
    expect(throttle.isThrottled("1.2.3.4")).toBe(false);
  });

  it("starts a new window once the old one lapses and clears on success", () => {
    const clock = { now: 1_000 };
    const throttle = createLoginThrottle(() => clock.now);
    for (let attempt = 0; attempt < 5; attempt += 1) throttle.recordFailure("k");
    clock.now += 5 * 60 * 1_000;
    throttle.recordFailure("k");
    expect(throttle.isThrottled("k")).toBe(false);
    for (let attempt = 0; attempt < 4; attempt += 1) throttle.recordFailure("k");
    expect(throttle.isThrottled("k")).toBe(true);
    throttle.clear("k");
    expect(throttle.isThrottled("k")).toBe(false);
  });
});
