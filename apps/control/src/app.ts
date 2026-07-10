import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

export interface ControlRuntimeConfig {
  originAuthToken(): string | undefined;
}

const SPIKE_WEBP = Uint8Array.from([
  82, 73, 70, 70, 30, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 17, 0, 0, 0, 47, 0, 0, 0, 0, 7, 208,
  255, 254, 247, 191, 255, 129, 136, 232, 127, 0, 0,
]);

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

export function createControlApp(runtime: ControlRuntimeConfig): Hono {
  const control = new Hono();

  control.get("/healthz", (context) => context.json({ ok: true, service: "control" }));

  control.get("/internal/v1/spike/rendition", (context) => {
    if (!authorized(context.req.header("authorization"), runtime.originAuthToken())) {
      return context.json({ error: { code: "unauthorized" } }, 401, {
        "cache-control": "private, no-store",
        "www-authenticate": "Bearer",
      });
    }

    const query = new URL(context.req.url).searchParams;
    if ([...query.keys()].some((key) => key !== "key") || query.getAll("key").length !== 1) {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }
    const key = query.get("key");
    if (key === null || !isCacheKey(key)) {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }

    return context.body(SPIKE_WEBP, 200, {
      "cache-control": "private, no-store",
      "content-type": "image/webp",
      "x-shutter-rendition-key": key,
    });
  });

  return control;
}

export const app = createControlApp({
  originAuthToken: () => process.env.ORIGIN_AUTH_TOKEN,
});
