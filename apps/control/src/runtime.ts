import { S3Client } from "@aws-sdk/client-s3";
import type { PreviewKind } from "@shutter/protocol";
import { Pool } from "pg";
import type { ControlRuntimeConfig } from "./app.js";
import { EdgeRefreshTracker } from "./edge-refresh-status.js";
import type { ServerEnv } from "./env/server.js";
import { createSerializedExecutorDispatch, sendExecutorWake } from "./executor-dispatch.js";
import type { ImgproxyConfig } from "./imgproxy.js";
import type { JobApiRuntime } from "./job-api.js";
import type { ControlLogger } from "./logging.js";
import { createMasterStore } from "./master-store.js";
import { PostgresPreviewJobLifecycle } from "./preview-job-lifecycle.js";
import { createSourcePurge } from "./source-purge.js";
import { CapabilityKeyEncryption } from "./spaces/encryption.js";
import { PostgresSpaceRegistry } from "./spaces/postgres-registry.js";

const EXECUTOR_WAKE_TIMEOUT_MS = 11 * 60 * 1_000;

export type ControlFeatureName =
  | "spaceRegistry"
  | "jobApi"
  | "masterStore"
  | "sourcePurge"
  | "imgproxy"
  | "executorDispatch"
  | "admin"
  | "edgeConfig";

/** `ready`, or the environment variables whose absence disabled the feature. */
export type ControlFeatureStatus = "ready" | { missing: readonly string[] };

export type ControlFeatures = Readonly<Record<ControlFeatureName, ControlFeatureStatus>>;

export interface ControlRuntime {
  config: ControlRuntimeConfig;
  jobApiRuntime: JobApiRuntime | undefined;
  features: ControlFeatures;
  /** Ends the connection pool and the S3 client. Safe on a runtime that never connected. */
  close(): Promise<void>;
}

export interface ControlRuntimeDependencies {
  logger: ControlLogger;
  fetch: typeof globalThis.fetch;
  now(): Date;
}

type EnvName = keyof ServerEnv;

const S3_INPUTS = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
const REGISTRY_INPUTS = ["DATABASE_URL", "SHUTTER_ENCRYPTION_KEY"] as const;

/**
 * Every optional feature and the environment variables that enable it. This
 * table is the one place a "feature X is unavailable because Y" decision is
 * made; the constructors below read the same names, so the boot report and
 * the wiring cannot disagree.
 */
const FEATURE_INPUTS = {
  spaceRegistry: REGISTRY_INPUTS,
  jobApi: REGISTRY_INPUTS,
  edgeConfig: [...REGISTRY_INPUTS, "EDGE_CONFIG_TOKEN"],
  admin: [...REGISTRY_INPUTS, "ADMIN_BOOTSTRAP_TOKEN"],
  masterStore: [...S3_INPUTS, "S3_BUCKET"],
  sourcePurge: [
    ...REGISTRY_INPUTS,
    ...S3_INPUTS,
    "S3_BUCKET",
    "CLOUDFLARE_ZONE_ID",
    "CLOUDFLARE_CACHE_PURGE_TOKEN",
    "EDGE_BASE_URL",
    "ORIGIN_AUTH_TOKEN",
  ],
  imgproxy: ["IMGPROXY_BASE_URL", "IMGPROXY_KEY", "IMGPROXY_SALT", "IMGPROXY_SECRET"],
  executorDispatch: [
    "VIDEO_EXECUTOR_BASE_URL",
    "VIDEO_EXECUTOR_TOKEN",
    "PDF_EXECUTOR_BASE_URL",
    "PDF_EXECUTOR_TOKEN",
  ],
} as const satisfies Record<ControlFeatureName, readonly EnvName[]>;

type Inputs<Names extends readonly EnvName[]> = { [Name in Names[number]]: string };

/**
 * Reads a set of environment names as strings. `values` is populated only when
 * every name is present, so a caller checks `missing` first and then reads
 * the values without a second round of undefined checks.
 */
function readInputs<const Names extends readonly EnvName[]>(
  env: ServerEnv,
  names: Names,
): { missing: readonly string[]; values: Inputs<Names> | undefined } {
  const missing = names.filter((name) => env[name] === undefined || env[name] === "");
  if (missing.length > 0) return { missing, values: undefined };
  const values = Object.fromEntries(names.map((name) => [name, String(env[name])]));
  return { missing, values: values as Inputs<Names> };
}

function statusOf(missing: readonly string[]): ControlFeatureStatus {
  return missing.length === 0 ? "ready" : { missing };
}

function malformed(name: EnvName, error: unknown): Error {
  return new Error(
    `${name} is set but not usable: ${error instanceof Error ? error.message : "unknown error"}`,
  );
}

/**
 * A supplied but malformed value must fail the boot, not silently build a
 * component that 503s every request ten minutes later. An absent value only
 * disables the feature, and appears in the boot report.
 */
function configuredEncryption(env: ServerEnv): CapabilityKeyEncryption | undefined {
  if (env.SHUTTER_ENCRYPTION_KEY === undefined) return undefined;
  try {
    return new CapabilityKeyEncryption(env.SHUTTER_ENCRYPTION_KEY);
  } catch (error) {
    throw malformed("SHUTTER_ENCRYPTION_KEY", error);
  }
}

function usableDatabaseUrl(env: ServerEnv): string | undefined {
  if (env.DATABASE_URL === undefined) return undefined;
  const protocol = new URL(env.DATABASE_URL).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw malformed("DATABASE_URL", new Error("expected a postgres:// or postgresql:// URL"));
  }
  return env.DATABASE_URL;
}

interface ExecutorEndpoint {
  baseUrl: string;
  token: string;
}

function executorEndpoints(env: ServerEnv): Record<PreviewKind, ExecutorEndpoint | undefined> {
  const endpoint = (baseUrl: string | undefined, token: string | undefined) =>
    baseUrl === undefined || token === undefined ? undefined : { baseUrl, token };
  return {
    video: endpoint(env.VIDEO_EXECUTOR_BASE_URL, env.VIDEO_EXECUTOR_TOKEN),
    pdf: endpoint(env.PDF_EXECUTOR_BASE_URL, env.PDF_EXECUTOR_TOKEN),
  };
}

/**
 * Environment in, resolved runtime out. Construction opens no connections:
 * `pg.Pool` and `S3Client` connect lazily, so a test can call this with a
 * literal `ServerEnv` and inspect what would have been wired.
 */
export function buildControlRuntime(
  env: ServerEnv,
  deps: ControlRuntimeDependencies,
): ControlRuntime {
  const { logger, fetch, now } = deps;
  // Malformed values are rejected here even when the feature they belong to
  // stays disabled for another missing input: a bad value is a bad value.
  const encryption = configuredEncryption(env);
  const databaseUrl = usableDatabaseUrl(env);

  // The registry, the job lifecycle, and the Job API stand or fall together:
  // Space authorization opens Capability Keys, so a registry without
  // encryption could only ever answer 503 on the routes that need it.
  const registryInputs = readInputs(env, FEATURE_INPUTS.spaceRegistry);
  const pool =
    registryInputs.values === undefined || databaseUrl === undefined || encryption === undefined
      ? undefined
      : new Pool({ connectionString: databaseUrl });
  const lifecycle = pool === undefined ? undefined : new PostgresPreviewJobLifecycle(pool);
  const spaceRegistry =
    pool === undefined || encryption === undefined
      ? undefined
      : new PostgresSpaceRegistry(pool, {
          encryption,
          now,
          onUndecryptableKeys: (_scope, count) => {
            logger.emit("error", { event: "control.registry.keys_excluded", count });
          },
        });

  const s3Inputs = readInputs(env, S3_INPUTS);
  const s3 =
    s3Inputs.values === undefined
      ? undefined
      : new S3Client({
          endpoint: s3Inputs.values.S3_ENDPOINT,
          region: env.S3_REGION,
          forcePathStyle: true,
          credentials: {
            accessKeyId: s3Inputs.values.S3_ACCESS_KEY_ID,
            secretAccessKey: s3Inputs.values.S3_SECRET_ACCESS_KEY,
          },
        });

  const masterStoreInputs = readInputs(env, FEATURE_INPUTS.masterStore);
  const masterStore =
    s3 === undefined || masterStoreInputs.values === undefined
      ? undefined
      : createMasterStore({ s3, bucket: masterStoreInputs.values.S3_BUCKET });

  const purgeInputs = readInputs(env, FEATURE_INPUTS.sourcePurge);
  const sourcePurge =
    s3 === undefined || lifecycle === undefined || purgeInputs.values === undefined
      ? undefined
      : createSourcePurge({
          logger,
          lifecycle,
          s3,
          bucket: purgeInputs.values.S3_BUCKET,
          cloudflareZoneId: purgeInputs.values.CLOUDFLARE_ZONE_ID,
          cloudflareApiToken: purgeInputs.values.CLOUDFLARE_CACHE_PURGE_TOKEN,
          edgeBaseUrl: purgeInputs.values.EDGE_BASE_URL,
          edgeAuthToken: purgeInputs.values.ORIGIN_AUTH_TOKEN,
          fetch,
        });

  const imgproxyInputs = readInputs(env, FEATURE_INPUTS.imgproxy);
  const imgproxyConfig: ImgproxyConfig | undefined =
    imgproxyInputs.values === undefined
      ? undefined
      : {
          baseUrl: imgproxyInputs.values.IMGPROXY_BASE_URL,
          key: imgproxyInputs.values.IMGPROXY_KEY,
          salt: imgproxyInputs.values.IMGPROXY_SALT,
          secret: imgproxyInputs.values.IMGPROXY_SECRET,
        };

  // Wake endpoints resolve once here. A kind whose executor is not configured
  // still rejects at dispatch time so a submission is accepted durably and the
  // failure is logged, rather than the whole Job API disappearing.
  const executors = executorEndpoints(env);
  const dispatch = createSerializedExecutorDispatch(async (kind) => {
    const endpoint = executors[kind];
    if (endpoint === undefined) throw new Error(`${kind} executor dispatch is not configured`);
    logger.emit("info", { event: "control.executor.delegated", kind, outcome: "accepted" });
    await sendExecutorWake({ ...endpoint, fetch, timeoutMs: EXECUTOR_WAKE_TIMEOUT_MS });
    logger.emit("info", { event: "control.executor.delegated", kind, outcome: "ready" });
  });

  const jobApiRuntime: JobApiRuntime | undefined =
    lifecycle === undefined || spaceRegistry === undefined
      ? undefined
      : {
          logger,
          lifecycle,
          now,
          spaceRegistry,
          executorToken: (kind) => executors[kind]?.token,
          dispatch,
          ...(sourcePurge === undefined ? {} : { sourcePurge }),
        };

  const features: ControlFeatures = {
    spaceRegistry: statusOf(registryInputs.missing),
    jobApi: statusOf(registryInputs.missing),
    edgeConfig: statusOf(readInputs(env, FEATURE_INPUTS.edgeConfig).missing),
    admin: statusOf(readInputs(env, FEATURE_INPUTS.admin).missing),
    masterStore: statusOf(masterStoreInputs.missing),
    sourcePurge: statusOf(purgeInputs.missing),
    imgproxy: statusOf(imgproxyInputs.missing),
    executorDispatch: statusOf(readInputs(env, FEATURE_INPUTS.executorDispatch).missing),
  };

  const config: ControlRuntimeConfig = {
    logger,
    originAuthToken: () => env.ORIGIN_AUTH_TOKEN,
    edgeConfigToken: () => env.EDGE_CONFIG_TOKEN,
    adminBootstrapToken: () => env.ADMIN_BOOTSTRAP_TOKEN,
    imgproxyAllowedSources: () => env.IMGPROXY_ALLOWED_SOURCES,
    imgproxyConfig: () => imgproxyConfig,
    fetch,
    edgeRefreshTracker: new EdgeRefreshTracker(now),
    ...(masterStore === undefined ? {} : { masterStore }),
    ...(jobApiRuntime === undefined ? {} : { jobApiRuntime }),
    ...(spaceRegistry === undefined ? {} : { spaceRegistry }),
  };

  return {
    config,
    jobApiRuntime,
    features,
    async close() {
      s3?.destroy();
      await pool?.end();
    },
  };
}

/**
 * The boot report as the fields of one `control.service.features` event:
 * how many features are not ready and, when any, `feature=VAR,VAR feature=VAR`.
 */
export function featureReport(features: ControlFeatures): { count: number; features?: string } {
  const entries = Object.entries(features).flatMap(([name, status]) =>
    status === "ready" ? [] : [`${name}=${status.missing.join(",")}`],
  );
  return entries.length === 0
    ? { count: 0 }
    : { count: entries.length, features: entries.join(" ") };
}
