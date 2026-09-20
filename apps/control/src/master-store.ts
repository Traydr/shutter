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

/**
 * The URL prefix every presigned Media Store read sits under. Control's S3
 * client is path-style, so the prefix is the endpoint followed by the bucket.
 * imgproxy must allow it, or no Master Preview can be optimized.
 */
export function mediaStoreSourcePrefix(endpoint: string, bucket: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}/${encodeURIComponent(bucket)}`;
}

export function createMasterStore(config: MasterStoreConfig): MasterStore {
  return {
    presignGet: (key) =>
      getSignedUrl(config.s3, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: MASTER_READ_EXPIRY_SECONDS,
      }),
  };
}
