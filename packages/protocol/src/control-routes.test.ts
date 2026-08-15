import { describe, expect, it } from "vitest";
import { buildOptimizeSourceQuery, parseOptimizeSourceQuery } from "./control-routes.js";

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
