import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Context, Data, Effect, Layer } from "effect";
import { ControlConfig } from "./env/server.js";

export const MASTER_READ_EXPIRY_SECONDS = 60;

export class MasterStoreError extends Data.TaggedError("MasterStoreError")<{
  readonly reason: "not_configured" | "request_failed";
  readonly cause?: unknown;
}> {}

export interface MasterStoreShape {
  presignGet(key: string): Effect.Effect<string, MasterStoreError>;
}

export class MasterStore extends Context.Service<MasterStore, MasterStoreShape>()(
  "@shutter/control/MasterStore",
) {
  static readonly layer = Layer.effect(
    MasterStore,
    Effect.map(ControlConfig, (config) => {
      if (
        config.s3Endpoint === undefined ||
        config.s3Bucket === undefined ||
        config.s3AccessKeyId === undefined ||
        config.s3SecretAccessKey === undefined
      ) {
        return MasterStore.of({
          presignGet: () => Effect.fail(new MasterStoreError({ reason: "not_configured" })),
        });
      }
      return createMasterStore({
        endpoint: config.s3Endpoint,
        region: config.s3Region,
        bucket: config.s3Bucket,
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey,
      });
    }),
  );
}

export interface MasterStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createMasterStore(config: MasterStoreConfig): MasterStoreShape {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return MasterStore.of({
    presignGet: (key) =>
      Effect.tryPromise({
        try: () =>
          getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
            expiresIn: MASTER_READ_EXPIRY_SECONDS,
          }),
        catch: (cause) => new MasterStoreError({ reason: "request_failed", cause }),
      }),
  });
}
