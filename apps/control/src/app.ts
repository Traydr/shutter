import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { buildImgproxyRequest, type ImgproxyConfig } from "./imgproxy.js";

export interface ControlRuntimeConfig {
  originAuthToken(): string | undefined;
  imgproxyConfig(): ImgproxyConfig | undefined;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function credentialDigest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorized(header: string | undefined, expectedToken: string | undefined): boolean {
  if (expectedToken === undefined || expectedToken.length < 32 || header === undefined)
    return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(
    credentialDigest(header.slice(prefix.length)),
    credentialDigest(expectedToken),
  );
}

function isCacheKey(value: string): boolean {
  return (
    value.startsWith("cache/v1/") &&
    value.endsWith(".webp") &&
    !value.includes("..") &&
    !value.includes("\\")
  );
}

function strictPositiveInteger(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function createControlApp(runtime: ControlRuntimeConfig): Hono {
  const control = new Hono();

  control.get("/healthz", (context) => context.json({ ok: true, service: "control" }));

  control.get("/internal/v1/spike/rendition", async (context) => {
    if (!authorized(context.req.header("authorization"), runtime.originAuthToken())) {
      return context.json({ error: { code: "unauthorized" } }, 401, {
        "cache-control": "private, no-store",
        "www-authenticate": "Bearer",
      });
    }

    const query = new URL(context.req.url).searchParams;
    const allowedKeys = new Set(["key", "source", "w", "q"]);
    if (
      [...query.keys()].some((key) => !allowedKeys.has(key)) ||
      [...allowedKeys].some((key) => query.getAll(key).length !== 1)
    ) {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }
    const key = query.get("key");
    const source = query.get("source");
    const width = strictPositiveInteger(query.get("w"));
    const quality = strictPositiveInteger(query.get("q"));
    const imgproxy = runtime.imgproxyConfig();
    if (
      key === null ||
      !isCacheKey(key) ||
      source === null ||
      width === undefined ||
      quality === undefined ||
      quality > 100 ||
      imgproxy === undefined
    ) {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }

    try {
      const request = buildImgproxyRequest({ sourceUrl: source, width, quality }, imgproxy);
      const response = await runtime.fetch(request.url, {
        headers: request.headers,
        redirect: "error",
      });
      if (!response.ok || response.body === null) {
        console.error({ status: response.status }, "imgproxy rendition failed");
        return context.json({ error: { code: "rendition_failed" } }, 502, {
          "cache-control": "private, no-store",
        });
      }
      const headers = new Headers({
        "cache-control": "private, no-store",
        "content-type": response.headers.get("content-type") ?? "image/webp",
        "x-shutter-rendition-key": key,
      });
      return new Response(response.body, { status: 200, headers });
    } catch (error) {
      console.error({ error: error instanceof Error ? error.message : "unknown" }, "imgproxy request failed");
      return context.json({ error: { code: "rendition_failed" } }, 502, {
        "cache-control": "private, no-store",
      });
    }
  });

  return control;
}

export const app = createControlApp({
  originAuthToken: () => process.env.ORIGIN_AUTH_TOKEN,
  imgproxyConfig: () => {
    const baseUrl = process.env.IMGPROXY_BASE_URL;
    const key = process.env.IMGPROXY_KEY;
    const salt = process.env.IMGPROXY_SALT;
    const secret = process.env.IMGPROXY_SECRET;
    return baseUrl && key && salt && secret ? { baseUrl, key, salt, secret } : undefined;
  },
  fetch: globalThis.fetch,
});
