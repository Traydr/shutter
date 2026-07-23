import { describe, expect, it } from "vitest";
import { buildR2CacheKey } from "./cache-identity.js";

const identity = {
  routeClass: "private" as const,
  spaceId: "pane-view",
  sourceId: "source-01",
  input: { type: "source" as const },
  width: 640,
  quality: 75,
};

describe("cache identity", () => {
  it("separates public/private, original/master, kind, width, and quality", async () => {
    const base = await buildR2CacheKey(identity);
    const variants = await Promise.all([
      buildR2CacheKey({ ...identity, routeClass: "public" }),
      buildR2CacheKey({ ...identity, input: { type: "master", kind: "video" } }),
      buildR2CacheKey({ ...identity, input: { type: "master", kind: "pdf" } }),
      buildR2CacheKey({ ...identity, width: 750 }),
      buildR2CacheKey({ ...identity, quality: 30 }),
      buildR2CacheKey({ ...identity, sourceId: "source-02" }),
    ]);
    expect(new Set([base, ...variants])).toHaveLength(variants.length + 1);
  });
});
