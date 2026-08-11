import { createHmac } from "node:crypto";
import { Context, Data, Effect, Layer } from "effect";
import { ControlConfig } from "./env/server.js";

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

export class ImgproxyError extends Data.TaggedError("ImgproxyError")<{
  readonly reason: "not_configured" | "request_invalid";
  readonly message: string;
}> {}

export interface ImgproxyShape {
  buildRequest(
    rendition: ImgproxyRendition,
  ): Effect.Effect<{ url: string; headers: Headers }, ImgproxyError>;
}

export class Imgproxy extends Context.Service<Imgproxy, ImgproxyShape>()(
  "@shutter/control/Imgproxy",
) {
  static readonly layer = Layer.effect(
    Imgproxy,
    Effect.map(ControlConfig, (config) => {
      const values = [
        config.imgproxyBaseUrl,
        config.imgproxyKey,
        config.imgproxySalt,
        config.imgproxySecret,
      ] as const;
      if (values.some((value) => value === undefined)) {
        return Imgproxy.of({
          buildRequest: () =>
            Effect.fail(
              new ImgproxyError({
                reason: "not_configured",
                message: "imgproxy is not configured",
              }),
            ),
        });
      }
      const [baseUrl, key, salt, secret] = values as readonly [string, string, string, string];
      const imgproxyConfig = { baseUrl, key, salt, secret };
      return Imgproxy.of({
        buildRequest: (rendition) => buildImgproxyRequestEffect(rendition, imgproxyConfig),
      });
    }),
  );
}

function invalid(message: string): ImgproxyError {
  return new ImgproxyError({ reason: "request_invalid", message });
}

function decodeHex(name: string, value: string): Buffer {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(value)) {
    throw invalid(`${name} must be non-empty hexadecimal`);
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
    throw invalid("IMGPROXY_BASE_URL must be an HTTP(S) origin");
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
    throw invalid("imgproxy source must be HTTPS without credentials or a fragment");
  }
  if (!Number.isSafeInteger(width) || width <= 0) throw invalid("width must be positive");
  if (!Number.isSafeInteger(quality) || quality <= 0 || quality > 100) {
    throw invalid("quality must be between 1 and 100");
  }
}

export function buildImgproxyRequest(
  rendition: ImgproxyRendition,
  config: ImgproxyConfig,
): { url: string; headers: Headers } {
  validateRendition(rendition);
  if (config.secret.length < 32) throw invalid("IMGPROXY_SECRET must be at least 32 characters");

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

export function buildImgproxyRequestEffect(
  rendition: ImgproxyRendition,
  config: ImgproxyConfig,
): Effect.Effect<{ url: string; headers: Headers }, ImgproxyError> {
  return Effect.try({
    try: () => buildImgproxyRequest(rendition, config),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof ImgproxyError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
}
