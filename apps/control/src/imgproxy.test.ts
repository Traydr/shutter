import { describe, expect, it } from "vitest";
import { buildImgproxyRequest } from "./imgproxy.js";

describe("imgproxy request signing", () => {
  it("locks the signed, width-only WebP request shape", () => {
    const request = buildImgproxyRequest(
      {
        sourceUrl: "https://t3.storageapi.dev/balanced-wrap-ocyiwwexhao/test image.jpg?token=one",
        width: 640,
        quality: 75,
      },
      {
        baseUrl: "http://shutter-imgproxy.railway.internal:8080",
        key: "736563726574",
        salt: "68656c6c6f",
        secret: "s".repeat(32),
      },
    );

    expect(request.url).toBe(
      "http://shutter-imgproxy.railway.internal:8080/EfOk8WqaN520nOwdb8C-aaCdIF-AgvkhBFXvTCToe20/rs:fit:640:0:0/q:75/aHR0cHM6Ly90My5zdG9yYWdlYXBpLmRldi9iYWxhbmNlZC13cmFwLW9jeWl3d2V4aGFvL3Rlc3QgaW1hZ2UuanBnP3Rva2VuPW9uZQ.webp",
    );
    expect(request.headers.get("authorization")).toBe(`Bearer ${"s".repeat(32)}`);
  });

  it("rejects unsafe sources and malformed signing material", () => {
    const config = {
      baseUrl: "http://shutter-imgproxy.railway.internal:8080",
      key: "not-hex",
      salt: "68656c6c6f",
      secret: "s".repeat(32),
    };

    expect(() =>
      buildImgproxyRequest(
        { sourceUrl: "http://example.com/image.jpg", width: 640, quality: 75 },
        config,
      ),
    ).toThrow("imgproxy source must be HTTPS");
    expect(() =>
      buildImgproxyRequest(
        { sourceUrl: "https://example.com/image.jpg", width: 640, quality: 75 },
        config,
      ),
    ).toThrow("IMGPROXY_KEY");
  });
});
