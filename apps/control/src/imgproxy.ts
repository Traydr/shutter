import { createHmac } from "node:crypto";

export interface ImgproxyConfig {
  baseUrl: string;
  key: string;
  salt: string;
  secret: string;
}

export interface ImgproxyRendition {
  sourceUrl: string;
  width: number;
  quality: number;
}

function decodeHex(name: string, value: string): Buffer {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(value)) {
    throw new Error(`${name} must be non-empty hexadecimal`);
  }
  return Buffer.from(value, "hex");
}

function imgproxyOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("IMGPROXY_BASE_URL must be an HTTP(S) origin");
  }
  return url.origin;
}

function validateRendition({ sourceUrl, width, quality }: ImgproxyRendition): void {
  const source = new URL(sourceUrl);
  if (
    source.protocol !== "https:" ||
    source.username !== "" ||
    source.password !== "" ||
    source.hash !== ""
  ) {
    throw new Error("imgproxy source must be HTTPS without credentials or a fragment");
  }
  if (!Number.isSafeInteger(width) || width <= 0) throw new Error("width must be positive");
  if (!Number.isSafeInteger(quality) || quality <= 0 || quality > 100) {
    throw new Error("quality must be between 1 and 100");
  }
}

export function buildImgproxyRequest(
  rendition: ImgproxyRendition,
  config: ImgproxyConfig,
): { url: string; headers: Headers } {
  validateRendition(rendition);
  if (config.secret.length < 32) throw new Error("IMGPROXY_SECRET must be at least 32 characters");

  const source = Buffer.from(rendition.sourceUrl, "utf8").toString("base64url");
  const processingPath = `/rs:fit:${rendition.width}:0:0/q:${rendition.quality}/${source}.webp`;
  const signature = createHmac("sha256", decodeHex("IMGPROXY_KEY", config.key))
    .update(decodeHex("IMGPROXY_SALT", config.salt))
    .update(processingPath)
    .digest("base64url");

  return {
    url: `${imgproxyOrigin(config.baseUrl)}/${signature}${processingPath}`,
    headers: new Headers({ authorization: `Bearer ${config.secret}` }),
  };
}
