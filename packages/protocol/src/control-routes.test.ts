import { describe, expect, it } from "vitest";
import {
  parseOptimizeRequest,
  parseResolveRequest,
  parseResolveResponse,
} from "./control-routes.js";

describe("v2 internal wire", () => {
  const request = { spaceId: "ernesta", width: 640, quality: 75 };

  it("parses each optimize input variant strictly", () => {
    expect(
      parseOptimizeRequest({
        ...request,
        input: { type: "resolved", resolverId: "media", reference: ["AbC123"] },
      }),
    ).toEqual({
      ...request,
      input: { type: "resolved", resolverId: "media", reference: ["AbC123"] },
    });
    expect(
      parseOptimizeRequest({ ...request, input: { type: "located", sourceUrl: "https://s/x" } }),
    ).toMatchObject({ input: { type: "located" } });
    expect(
      parseOptimizeRequest({
        ...request,
        input: { type: "master", sourceId: "media/tour", kind: "video" },
      }),
    ).toMatchObject({ input: { kind: "video" } });
  });

  it.each([
    ["an unknown input type", { ...request, input: { type: "callback", url: "https://s" } }],
    [
      "a field from another variant",
      { ...request, input: { type: "located", sourceUrl: "https://s", kind: "video" } },
    ],
    [
      "an empty reference",
      { ...request, input: { type: "resolved", resolverId: "m", reference: [] } },
    ],
    [
      "a quality above 100",
      { ...request, quality: 101, input: { type: "located", sourceUrl: "https://s" } },
    ],
    [
      "a missing width",
      { spaceId: "e", quality: 75, input: { type: "located", sourceUrl: "https://s" } },
    ],
  ])("rejects %s", (_label, body) => {
    expect(() => parseOptimizeRequest(body)).toThrow(
      expect.objectContaining({ code: "request_invalid" }),
    );
  });

  it("parses resolve requests and responses", () => {
    expect(parseResolveRequest({ spaceId: "e", resolverId: "media", reference: ["a"] })).toEqual({
      spaceId: "e",
      resolverId: "media",
      reference: ["a"],
    });
    expect(
      parseResolveResponse({ locator: "https://s/x?sig=1", expiresAt: "2026-09-09T12:10:00Z" }),
    ).toEqual({ locator: "https://s/x?sig=1", expiresAt: "2026-09-09T12:10:00Z" });
    expect(() => parseResolveResponse({ locator: "https://s/x", expiresAt: "soon" })).toThrow(
      expect.objectContaining({ code: "request_invalid" }),
    );
  });
});
