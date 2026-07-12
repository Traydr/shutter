import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import {
  buildMasterPurgePrefix,
  buildR2CachePurgePrefix,
  buildSourceCacheTag,
} from "@shutter/protocol";

export interface SourcePurger {
  purge(spaceId: string, sourceId: string): Promise<void>;
}

export interface SourcePurgerConfig {
  s3: S3Client;
  bucket: string;
  cloudflareZoneId: string;
  cloudflareApiToken: string;
  fetch: typeof globalThis.fetch;
}

async function deletePrefix(s3: S3Client, bucket: string, prefix: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
      }),
    );
    const objects = (page.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [{ Key: object.Key }],
    );
    if (objects.length > 0) {
      const deleted = await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
      );
      if ((deleted.Errors?.length ?? 0) > 0) throw new Error("rendition deletion failed");
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && continuationToken === undefined)
      throw new Error("rendition listing pagination failed");
  } while (continuationToken !== undefined);
}

export function createSourcePurger(config: SourcePurgerConfig): SourcePurger {
  return {
    async purge(spaceId, sourceId) {
      const prefixes = await Promise.all([
        buildR2CachePurgePrefix("public", spaceId, sourceId),
        buildR2CachePurgePrefix("private", spaceId, sourceId),
        buildMasterPurgePrefix(spaceId, sourceId),
      ]);
      for (const prefix of prefixes) await deletePrefix(config.s3, config.bucket, prefix);

      const tag = await buildSourceCacheTag(spaceId, sourceId);
      const response = await config.fetch(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(config.cloudflareZoneId)}/purge_cache`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.cloudflareApiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ tags: [tag] }),
        },
      );
      if (!response.ok) throw new Error("cache tag purge failed");
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new Error("cache tag purge failed");
      }
      if (
        typeof result !== "object" ||
        result === null ||
        !("success" in result) ||
        result.success !== true
      ) {
        throw new Error("cache tag purge failed");
      }
    },
  };
}
