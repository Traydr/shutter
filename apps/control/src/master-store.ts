import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const MASTER_READ_EXPIRY_SECONDS = 60;

export interface MasterStore {
  presignGet(key: string): Promise<string>;
}

export interface MasterStoreConfig {
  s3: S3Client;
  bucket: string;
}

export function createMasterStore(config: MasterStoreConfig): MasterStore {
  return {
    presignGet: (key) =>
      getSignedUrl(config.s3, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: MASTER_READ_EXPIRY_SECONDS,
      }),
  };
}
