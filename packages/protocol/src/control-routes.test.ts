import { describe, expect, it } from "vitest";
import {
  buildOptimizeSourceQuery,
  parseOptimizeRequest,
  parseOptimizeSourceQuery,
  parseResolveRequest,
  parseResolveResponse,
} from "./control-routes.js";

const query = {
  spaceId: "example-private",
  sourceUrl: "https://sources.example.com/private/originals/test.jpg?X-Amz-Signature=abc&x=1",
  width: 640,
  quality: 75,
};

describe("optimize-source query", () => {
  it("round-trips through the builder and parser", () => {
    const parameters = buildOptimizeSourceQuery(query);
    expect([...parameters.keys()]).toEqual(["space", "source", "w", "q"]);
    expect(parseOptimizeSourceQuery(new URLSearchParams(parameters.toString()))).toEqual(query);
  });

  it.each([
    ["a duplicate key", "space=a&space=b&source=https://s.example/x&w=640&q=75"],
    ["an unknown key", "space=a&source=https://s.example/x&w=640&q=75&key=cache/v1/x"],
    ["a missing space", "source=https://s.example/x&w=640&q=75"],
    ["an empty space", "space=&source=https://s.example/x&w=640&q=75"],
    ["a non-integer width", "space=a&source=https://s.example/x&w=640.5&q=75"],
    ["a zero width", "space=a&source=https://s.example/x&w=0&q=75"],
    ["a signed width", "space=a&source=https://s.example/x&w=+640&q=75"],
    ["a quality above 100", "space=a&source=https://s.example/x&w=640&q=101"],
  ])("rejects %s", (_label, search) => {
    expect(() => parseOptimizeSourceQuery(new URLSearchParams(search))).toThrow(
      expect.objectContaining({ code: "request_invalid" }),
    );
  });
});

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
