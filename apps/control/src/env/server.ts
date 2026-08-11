import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const optionalString = z.string().min(1).optional();
const optionalUrl = z.url().optional();

const server = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65_535).default(3_000),

  DATABASE_URL: optionalUrl,
  CAPABILITY_KEYS: optionalString,
  SHUTTER_ENCRYPTION_KEY: optionalString,
  SPACE_API_TOKENS: optionalString,

  S3_ENDPOINT: optionalUrl,
  S3_REGION: z.string().min(1).default("auto"),
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,

  CLOUDFLARE_ZONE_ID: optionalString,
  CLOUDFLARE_CACHE_PURGE_TOKEN: optionalString,
  EDGE_BASE_URL: optionalUrl,
  ORIGIN_AUTH_TOKEN: optionalString,

  IMGPROXY_BASE_URL: optionalUrl,
  IMGPROXY_KEY: optionalString,
  IMGPROXY_SALT: optionalString,
  IMGPROXY_SECRET: optionalString,

  VIDEO_EXECUTOR_BASE_URL: optionalUrl,
  VIDEO_EXECUTOR_TOKEN: optionalString,
  PDF_EXECUTOR_BASE_URL: optionalUrl,
  PDF_EXECUTOR_TOKEN: optionalString,

  // These stay as raw optional strings so logging configuration errors remain
  // non-fatal and are reported through the stdout-only diagnostic path.
  OTEL_EXPORTER_OTLP_LOGS_ALLOWED_ENDPOINTS: z.string().optional(),
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: z.string().optional(),
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: z.string().optional(),
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: z.string().optional(),
  OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: z.string().optional(),

  RAILWAY_GIT_COMMIT_SHA: optionalString,
  RAILWAY_ENVIRONMENT_NAME: optionalString,
  RAILWAY_REPLICA_ID: optionalString,
  RAILWAY_REPLICA_REGION: optionalString,
  RAILWAY_DEPLOYMENT_ID: optionalString,

  npm_package_version: optionalString,
  TEST_POSTGRES_URL: optionalUrl,
};

export function createServerEnv(runtimeEnv: NodeJS.ProcessEnv) {
  return createEnv({
    server,
    runtimeEnv,
    emptyStringAsUndefined: true,
  });
}

export type ServerEnv = ReturnType<typeof createServerEnv>;

export const env = createServerEnv(process.env);

export function setTestPostgresUrl(value: string): void {
  process.env.TEST_POSTGRES_URL = value;
}
