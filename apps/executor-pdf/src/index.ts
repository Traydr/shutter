import { S3Client } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { createPdfExecutorApp } from "./app.js";
import { type PdfExecutorConfig, runPdfOnce } from "./run-once.js";

const required = [
  "CONTROL_BASE_URL",
  "EXECUTOR_ROLE_TOKEN",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET",
] as const;
const configured = required.every((name) => process.env[name] !== undefined);
const executorConfig: (PdfExecutorConfig & { triggerToken?: string }) | undefined = configured
  ? {
      controlBaseUrl: process.env.CONTROL_BASE_URL as string,
      roleToken: process.env.EXECUTOR_ROLE_TOKEN as string,
      ...(process.env.EXECUTOR_TRIGGER_TOKEN === undefined
        ? {}
        : { triggerToken: process.env.EXECUTOR_TRIGGER_TOKEN }),
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
const app = createPdfExecutorApp(executorConfig);

const portValue = process.env.PORT ?? "3000";
if (!/^[1-9]\d*$/.test(portValue)) throw new Error("PORT must be a positive integer");

const port = Number(portValue);
if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("PORT is out of range");

const server = serve({ fetch: app.fetch, port });
const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? "5000");
if (!Number.isSafeInteger(pollInterval) || pollInterval < 1_000)
  throw new Error("POLL_INTERVAL_MS must be an integer of at least 1000");
let stopping = false;
let pollTimer: NodeJS.Timeout | undefined;

async function poll(): Promise<void> {
  if (stopping || executorConfig === undefined) return;
  try {
    await runPdfOnce(executorConfig);
  } catch (error) {
    console.error(
      { error: error instanceof Error ? error.message : "unknown" },
      "PDF executor poll failed",
    );
  } finally {
    if (!stopping) pollTimer = setTimeout(() => void poll(), pollInterval);
  }
}

if (executorConfig !== undefined) void poll();

function shutdown(signal: string) {
  stopping = true;
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  server.close((error) => {
    if (error) {
      console.error({ error, signal }, "failed to stop PDF executor");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
