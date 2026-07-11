import { S3Client } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { createVideoExecutorApp } from "./app.js";
import type { VideoExecutorConfig } from "./run-once.js";

const required = [
  "CONTROL_BASE_URL",
  "EXECUTOR_ROLE_TOKEN",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET",
] as const;
const configured = required.every((name) => process.env[name] !== undefined);
const executorConfig: VideoExecutorConfig | undefined = configured
  ? {
      controlBaseUrl: process.env.CONTROL_BASE_URL as string,
      roleToken: process.env.EXECUTOR_ROLE_TOKEN as string,
      bucket: process.env.S3_BUCKET as string,
      fetch: globalThis.fetch,
      s3: new S3Client({
        region: process.env.S3_REGION ?? "auto",
        endpoint: process.env.S3_ENDPOINT as string,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
        },
      }),
    }
  : undefined;
const app = createVideoExecutorApp(executorConfig);

const portValue = process.env.PORT ?? "3000";
if (!/^[1-9]\d*$/.test(portValue)) throw new Error("PORT must be a positive integer");

const port = Number(portValue);
if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("PORT is out of range");

const server = serve({ fetch: app.fetch, port });

function shutdown(signal: string) {
  server.close((error) => {
    if (error) {
      console.error({ error, signal }, "failed to stop video executor");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
