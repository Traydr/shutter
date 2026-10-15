import { describe, expect, it } from "vitest";
import { EdgeRefreshTracker } from "./edge-refresh-status.js";

describe("EdgeRefreshTracker", () => {
  it("keeps the newest reported generation and updates equal-generation time", () => {
    let now = new Date("2026-08-11T12:00:00.000Z");
    const tracker = new EdgeRefreshTracker(() => now);
    tracker.report(5);
    now = new Date("2026-08-11T12:01:00.000Z");
    tracker.report(4);
    expect(tracker.latest()).toEqual({
      generation: 5,
      refreshedAt: new Date("2026-08-11T12:00:00.000Z"),
    });
    tracker.report(5);
    expect(tracker.latest()).toEqual({ generation: 5, refreshedAt: now });
  });

  it("ignores invalid reports", () => {
    const tracker = new EdgeRefreshTracker();
    tracker.report(-1);
    tracker.report(1.5);
    expect(tracker.latest()).toBeUndefined();
  });

  it("wants a report until it holds a fresh one for the served generation", () => {
    let now = new Date("2026-08-11T12:00:00.000Z");
    const tracker = new EdgeRefreshTracker(() => now);
    expect(tracker.directiveFor(3)).toBe("wanted");

    tracker.report(3);
    expect(tracker.directiveFor(3)).toBe("current");
    expect(tracker.directiveFor(2)).toBe("current");
    expect(tracker.directiveFor(4)).toBe("wanted");

    now = new Date("2026-08-11T12:04:59.999Z");
    expect(tracker.directiveFor(3)).toBe("current");
    now = new Date("2026-08-11T12:05:00.000Z");
    expect(tracker.directiveFor(3)).toBe("wanted");
  });
});
