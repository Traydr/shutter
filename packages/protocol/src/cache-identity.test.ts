import { describe, expect, it } from "vitest";
import {
  buildCanonicalCacheUrl,
  buildMasterPreviewKey,
  buildR2CacheKey,
  buildSourceCacheTag,
  sourceFingerprint,
} from "./cache-identity.js";

const identity = {
  routeClass: "private" as const,
  spaceId: "pane-view",
  sourceId: "source-01",
  input: { type: "source" as const },
  width: 640,
  quality: 75,
};

describe("cache identity", () => {
  it("is deterministic and safe for keys and tags", async () => {
    const first = await sourceFingerprint(identity.spaceId, identity.sourceId);
    const second = await sourceFingerprint(identity.spaceId, identity.sourceId);
    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(buildSourceCacheTag(identity.spaceId, identity.sourceId)).resolves.toBe(
      `shutter-v1-${first}`,
    );
  });

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

  it("builds a non-public synthetic URL and a distinct durable master key", async () => {
    await expect(buildCanonicalCacheUrl(identity)).resolves.toMatch(
      /^https:\/\/cache\.shutter\.invalid\/cache\/v1\/private\//u,
    );
    await expect(buildMasterPreviewKey("pane-view", "source-01", "video")).resolves.toMatch(
      /^masters\/v1\/pane-view\/.+\/video\.webp$/u,
    );
  });
});
