import { createHash, timingSafeEqual } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { buildMasterPreviewKey } from "@shutter/protocol";
import { Hono } from "hono";
import { Pool } from "pg";
import { buildImgproxyRequest, type ImgproxyConfig } from "./imgproxy.js";
import { createJobApi, type JobApiRuntime } from "./job-api.js";
import { PostgresJobStore } from "./job-store.js";
import { createMasterStore, type MasterStore } from "./master-store.js";
import { createSourcePurger } from "./source-purge.js";

const EXECUTOR_WAKE_TIMEOUT_MS = 11 * 60 * 1_000;

export interface ControlRuntimeConfig {
  originAuthToken(): string | undefined;
  imgproxyConfig(): ImgproxyConfig | undefined;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  masterStore?: MasterStore;
  jobApiRuntime?: JobApiRuntime;
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
  if (runtime.jobApiRuntime !== undefined) control.route("/", createJobApi(runtime.jobApiRuntime));

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
      console.error(
        { error: error instanceof Error ? error.message : "unknown" },
        "imgproxy request failed",
      );
      return context.json({ error: { code: "rendition_failed" } }, 502, {
        "cache-control": "private, no-store",
      });
    }
  });

  control.post("/internal/v1/master-rendition", async (context) => {
    if (!authorized(context.req.header("authorization"), runtime.originAuthToken())) {
      return context.json({ error: { code: "unauthorized" } }, 401, {
        "cache-control": "private, no-store",
        "www-authenticate": "Bearer",
      });
    }
    let body: unknown;
    try {
      if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json"))
        throw new Error("invalid content type");
      body = await context.req.json();
    } catch {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return context.json({ error: { code: "request_invalid" } }, 400);
    const value = body as Record<string, unknown>;
    const allowed = new Set(["spaceId", "sourceId", "kind", "w", "q"]);
    const width = typeof value.w === "number" ? value.w : undefined;
    const quality = typeof value.q === "number" ? value.q : undefined;
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      typeof value.spaceId !== "string" ||
      typeof value.sourceId !== "string" ||
      (value.kind !== "video" && value.kind !== "pdf") ||
      !Number.isSafeInteger(width) ||
      width === undefined ||
      width <= 0 ||
      !Number.isSafeInteger(quality) ||
      quality === undefined ||
      quality <= 0 ||
      quality > 100 ||
      runtime.masterStore === undefined
    ) {
      return context.json({ error: { code: "request_invalid" } }, 400, {
        "cache-control": "private, no-store",
      });
    }
    try {
      const key = await buildMasterPreviewKey(value.spaceId, value.sourceId, value.kind);
      const sourceUrl = await runtime.masterStore.presignGet(key);
      const imgproxy = runtime.imgproxyConfig();
      if (imgproxy === undefined) throw new Error("imgproxy unavailable");
      const request = buildImgproxyRequest({ sourceUrl, width, quality }, imgproxy);
      const response = await runtime.fetch(request.url, {
        headers: request.headers,
        redirect: "error",
      });
      if (!response.ok || response.body === null) throw new Error("rendition failed");
      return new Response(response.body, {
        headers: {
          "cache-control": "private, no-store",
          "content-type": response.headers.get("content-type") ?? "image/webp",
        },
      });
    } catch {
      console.error({ kind: value.kind }, "master rendition failed");
      return context.json({ error: { code: "rendition_failed" } }, 502, {
        "cache-control": "private, no-store",
      });
    }
  });

  return control;
}

function decodeBase64Url(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

function parseStringRegistry(value: string | undefined): Map<string, readonly string[]> {
  if (value === undefined) return new Map();
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return new Map(
    Object.entries(parsed).map(([spaceId, entry]) => [
      spaceId,
      Array.isArray(entry)
        ? entry.filter((candidate): candidate is string => typeof candidate === "string")
        : typeof entry === "string"
          ? [entry]
          : [],
    ]),
  );
}

function parseCapabilityKeys(
  value: string | undefined,
): Map<string, ReadonlyMap<string, Uint8Array>> {
  if (value === undefined) return new Map();
  const parsed = JSON.parse(value) as Record<string, Record<string, string>>;
  return new Map(
    Object.entries(parsed).map(([spaceId, keys]) => [
      spaceId,
      new Map(Object.entries(keys).map(([kid, key]) => [kid, decodeBase64Url(key)])),
    ]),
  );
}

async function dispatchExecutor(kind: "video" | "pdf"): Promise<void> {
  const baseUrl =
    kind === "video" ? process.env.VIDEO_EXECUTOR_BASE_URL : process.env.PDF_EXECUTOR_BASE_URL;
  const token =
    kind === "video" ? process.env.VIDEO_EXECUTOR_TOKEN : process.env.PDF_EXECUTOR_TOKEN;
  if (baseUrl === undefined || token === undefined) {
    throw new Error(`${kind} executor dispatch is not configured`);
  }
  const response = await globalThis.fetch(new URL("/internal/v1/run-once", baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(EXECUTOR_WAKE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${kind} executor wake failed with ${response.status}`);
}

const databaseUrl = process.env.DATABASE_URL;
const jobPool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
const jobStore = jobPool === undefined ? undefined : new PostgresJobStore(jobPool);
const masterStore =
  process.env.S3_ENDPOINT &&
  process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY
    ? createMasterStore({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION ?? "auto",
        bucket: process.env.S3_BUCKET,
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      })
    : undefined;
const renditionS3 =
  process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
    ? new S3Client({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION ?? "auto",
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
      })
    : undefined;
const sourcePurger =
  renditionS3 &&
  process.env.S3_BUCKET &&
  process.env.CLOUDFLARE_ZONE_ID &&
  process.env.CLOUDFLARE_CACHE_PURGE_TOKEN
    ? createSourcePurger({
        s3: renditionS3,
        bucket: process.env.S3_BUCKET,
        cloudflareZoneId: process.env.CLOUDFLARE_ZONE_ID,
        cloudflareApiToken: process.env.CLOUDFLARE_CACHE_PURGE_TOKEN,
        fetch: globalThis.fetch,
      })
    : undefined;

export const jobApiRuntime: JobApiRuntime | undefined =
  jobStore === undefined
    ? undefined
    : {
        store: jobStore,
        now: () => new Date(),
        spaceApiTokens: () => parseStringRegistry(process.env.SPACE_API_TOKENS),
        capabilityKeys: () => parseCapabilityKeys(process.env.CAPABILITY_KEYS),
        executorToken: (kind) =>
          kind === "video" ? process.env.VIDEO_EXECUTOR_TOKEN : process.env.PDF_EXECUTOR_TOKEN,
        dispatch: dispatchExecutor,
        ...(sourcePurger === undefined ? {} : { sourcePurger }),
      };

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
  ...(masterStore === undefined ? {} : { masterStore }),
  ...(jobApiRuntime === undefined ? {} : { jobApiRuntime }),
});
