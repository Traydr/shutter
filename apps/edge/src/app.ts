import type { JsonValue } from "@shutter/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { registerOptimizationRoutes } from "./optimization-routes.js";
import { registerSourceDeliveryRoutes } from "./source-delivery-routes.js";

declare module "hono" {
  interface ExecutionContext {
    cache?: CacheContext;
  }
}

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= (left.at(index) ?? 0) ^ (right.at(index) ?? 0);
  }
  return diff === 0;
}

async function authorizedOrigin(
  header: string | undefined,
  expectedToken: string,
): Promise<boolean> {
  if (expectedToken.length < 32 || header === undefined || !header.startsWith("Bearer "))
    return false;
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header.slice("Bearer ".length))),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
  ]);
  return timingSafeEqualBytes(new Uint8Array(actual), new Uint8Array(expected));
}

/** A cache purge names one or more non-empty cache tags and nothing else. */
const purgeRequestSchema = z.strictObject({
  tags: z.array(z.string().min(1)).nonempty(),
});

export const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/healthz", (context) => context.json({ ok: true, service: "edge" }));

registerSourceDeliveryRoutes(app);

app.post("/internal/v1/cache/purge", async (context) => {
  if (
    !(await authorizedOrigin(context.req.header("authorization"), context.env.ORIGIN_AUTH_TOKEN))
  ) {
    return context.json({ error: { code: "unauthorized" } }, 401, {
      "cache-control": "private, no-store",
      "www-authenticate": "Bearer",
    });
  }

  let body: JsonValue;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: { code: "request_invalid" } }, 400, {
      "cache-control": "private, no-store",
    });
  }
  const purge = purgeRequestSchema.safeParse(body);
  if (!purge.success) {
    return context.json({ error: { code: "request_invalid" } }, 400, {
      "cache-control": "private, no-store",
    });
  }

  const cache = context.executionCtx.cache;
  if (cache === undefined) {
    return context.json({ error: { code: "service_unavailable" } }, 503, {
      "cache-control": "private, no-store",
    });
  }
  const result = await cache.purge({ tags: purge.data.tags });
  if (!result.success) {
    return context.json({ error: { code: "service_unavailable" } }, 503, {
      "cache-control": "private, no-store",
    });
  }
  return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
});

registerOptimizationRoutes(app);
