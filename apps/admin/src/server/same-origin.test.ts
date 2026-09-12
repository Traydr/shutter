import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "./same-origin.js";

function request(headers: Record<string, string>): Request {
  return new Request("https://admin.example.test/_serverFn/x", { method: "POST", headers });
}

describe("same-origin check", () => {
  it("trusts Sec-Fetch-Site when the browser sends it", () => {
    expect(isSameOriginRequest(request({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(request({ "sec-fetch-site": "none" }))).toBe(true);
    expect(isSameOriginRequest(request({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(
      isSameOriginRequest(
        request({ "sec-fetch-site": "same-site", origin: "https://admin.example.test" }),
      ),
    ).toBe(false);
  });

  it("falls back to the Origin host", () => {
    expect(isSameOriginRequest(request({ origin: "https://admin.example.test" }))).toBe(true);
    expect(isSameOriginRequest(request({ origin: "https://evil.example.test" }))).toBe(false);
    expect(isSameOriginRequest(request({ origin: "null" }))).toBe(false);
    expect(isSameOriginRequest(request({}))).toBe(true);
  });
});
