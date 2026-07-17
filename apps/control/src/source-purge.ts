import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import {
  buildMasterPurgePrefix,
  buildR2CachePurgePrefix,
  buildSourceCacheTag,
  emitOperationalEvent,
  operationalEvent,
} from "@shutter/protocol";
import type { RenditionJobLifecycle, SourceIdentity } from "./rendition-job-lifecycle.js";

export interface SourcePurge {
  purge(source: SourceIdentity): Promise<void>;
}

export interface SourcePurgeConfig {
  lifecycle: RenditionJobLifecycle;
  s3: S3Client;
  bucket: string;
  cloudflareZoneId: string;
  cloudflareApiToken: string;
  edgeBaseUrl: string;
  edgeAuthToken: string;
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

export function createSourcePurge(config: SourcePurgeConfig): SourcePurge {
  return {
    async purge(source) {
      try {
        await config.lifecycle.withInvalidatedSource(source, async () => {
          const prefixes = await Promise.all([
            buildR2CachePurgePrefix("public", source.spaceId, source.sourceId),
            buildR2CachePurgePrefix("private", source.spaceId, source.sourceId),
            buildMasterPurgePrefix(source.spaceId, source.sourceId),
          ]);
          for (const prefix of prefixes) await deletePrefix(config.s3, config.bucket, prefix);

          const tag = await buildSourceCacheTag(source.spaceId, source.sourceId);
          const edgePurge = await config.fetch(
            new URL("/internal/v1/cache/purge", config.edgeBaseUrl),
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${config.edgeAuthToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ tags: [tag] }),
            },
          );
          if (!edgePurge.ok) throw new Error("worker cache purge failed");

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
        });
        emitOperationalEvent(
          "info",
          await operationalEvent({
            event: "control.purge.completed",
            spaceId: source.spaceId,
            sourceId: source.sourceId,
            fields: { outcome: "ready" },
          }),
        );
      } catch (error) {
        emitOperationalEvent(
          "error",
          await operationalEvent({
            event: "control.purge.failed",
            spaceId: source.spaceId,
            sourceId: source.sourceId,
            fields: { outcome: "failed", failureCode: "service_unavailable" },
          }),
        );
        throw error;
      }
    },
  };
}
