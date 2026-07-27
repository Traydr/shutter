import { describe, expect, it } from "vitest";
import { buildImgproxyRequest } from "./imgproxy.js";

describe("imgproxy request signing", () => {
  it("locks the signed, width-only WebP request shape", () => {
    const request = buildImgproxyRequest(
      {
        sourceUrl: "https://objects.example.com/demo-private-bucket/test image.jpg?token=one",
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
      "http://shutter-imgproxy.railway.internal:8080/1tk5YAunbK-1redr90PFsQtEzy5NTH-vN_dS9gxC2_k/rs:fit:640:0:0/q:75/aHR0cHM6Ly9vYmplY3RzLmV4YW1wbGUuY29tL2RlbW8tcHJpdmF0ZS1idWNrZXQvdGVzdCBpbWFnZS5qcGc_dG9rZW49b25l.webp",
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
