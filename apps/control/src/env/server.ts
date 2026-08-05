import { Config, ConfigProvider, Context, type Effect, Layer, Option, Schema } from "effect";

const optionalString = (name: string) =>
  Config.option(Config.string(name)).pipe(Config.map(Option.getOrUndefined));

const optionalUrl = (name: string) =>
  Config.option(Config.schema(Schema.URLFromString, name)).pipe(
    Config.map(Option.map((url) => url.href)),
    Config.map(Option.getOrUndefined),
  );

const controlConfig = Config.unwrap({
  nodeEnv: Config.literals(["development", "test", "production"], "NODE_ENV").pipe(
    Config.withDefault("development" as const),
  ),
  port: Config.port("PORT").pipe(Config.withDefault(3_000)),

  databaseUrl: optionalUrl("DATABASE_URL"),
  capabilityKeys: optionalString("CAPABILITY_KEYS"),
  spaceApiTokens: optionalString("SPACE_API_TOKENS"),

  s3Endpoint: optionalUrl("S3_ENDPOINT"),
  s3Region: Config.string("S3_REGION").pipe(Config.withDefault("auto")),
  s3Bucket: optionalString("S3_BUCKET"),
  s3AccessKeyId: optionalString("S3_ACCESS_KEY_ID"),
  s3SecretAccessKey: optionalString("S3_SECRET_ACCESS_KEY"),

  cloudflareZoneId: optionalString("CLOUDFLARE_ZONE_ID"),
  cloudflareCachePurgeToken: optionalString("CLOUDFLARE_CACHE_PURGE_TOKEN"),
  edgeBaseUrl: optionalUrl("EDGE_BASE_URL"),
  originAuthToken: optionalString("ORIGIN_AUTH_TOKEN"),

  imgproxyBaseUrl: optionalUrl("IMGPROXY_BASE_URL"),
  imgproxyKey: optionalString("IMGPROXY_KEY"),
  imgproxySalt: optionalString("IMGPROXY_SALT"),
  imgproxySecret: optionalString("IMGPROXY_SECRET"),

  videoExecutorBaseUrl: optionalUrl("VIDEO_EXECUTOR_BASE_URL"),
  videoExecutorToken: optionalString("VIDEO_EXECUTOR_TOKEN"),
  pdfExecutorBaseUrl: optionalUrl("PDF_EXECUTOR_BASE_URL"),
  pdfExecutorToken: optionalString("PDF_EXECUTOR_TOKEN"),

  // These remain optional raw strings so invalid telemetry configuration is
  // reported through the stdout-only diagnostic path without blocking startup.
  otlpLogsAllowedEndpoints: optionalString("OTEL_EXPORTER_OTLP_LOGS_ALLOWED_ENDPOINTS"),
  otlpLogsEndpoint: optionalString("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"),
  otlpLogsHeaders: optionalString("OTEL_EXPORTER_OTLP_LOGS_HEADERS"),
  otlpLogsProtocol: optionalString("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL"),
  otlpLogsTimeout: optionalString("OTEL_EXPORTER_OTLP_LOGS_TIMEOUT"),

  railwayGitCommitSha: optionalString("RAILWAY_GIT_COMMIT_SHA"),
  railwayEnvironmentName: optionalString("RAILWAY_ENVIRONMENT_NAME"),
  railwayReplicaId: optionalString("RAILWAY_REPLICA_ID"),
  railwayReplicaRegion: optionalString("RAILWAY_REPLICA_REGION"),
  railwayDeploymentId: optionalString("RAILWAY_DEPLOYMENT_ID"),

  packageVersion: optionalString("npm_package_version"),
  testPostgresUrl: optionalUrl("TEST_POSTGRES_URL"),
});

export type ControlConfigShape = Config.Success<typeof controlConfig>;

export class ControlConfig extends Context.Service<ControlConfig, ControlConfigShape>()(
  "@shutter/control/ControlConfig",
) {
  static readonly layer = Layer.effect(ControlConfig, loadControlConfig(process.env));
}

export function loadControlConfig(
  runtimeEnv: Record<string, string | undefined>,
): Effect.Effect<ControlConfigShape, Config.ConfigError> {
  return controlConfig.parse(
    ConfigProvider.fromEnv({
      env: Object.fromEntries(
        Object.entries(runtimeEnv).filter(
          (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "",
        ),
      ),
    }),
  );
}

export function setTestPostgresUrl(value: string): void {
  process.env.TEST_POSTGRES_URL = value;
}
