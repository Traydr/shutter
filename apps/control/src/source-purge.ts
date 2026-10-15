import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import {
  buildMasterPurgePrefix,
  buildR2CachePurgePrefix,
  buildSourceCacheTag,
  type JsonValue,
  operationalEvent,
  type RouteClass,
} from "@shutter/protocol";
import { z } from "zod";
import type { ControlLogger } from "./logging.js";
import type { PreviewJobLifecycle, SourceIdentity } from "./preview-job-lifecycle.js";

/** The one field of a Cloudflare purge response that decides success. */
const purgeSucceededSchema = z.object({ success: z.literal(true) });

/**
 * How long one step of a purge may take: one R2 list or delete request, the
 * Worker cache purge, or the zone purge. A step that overruns fails the purge
 * with a retryable error rather than holding its database connection open.
 */
export const PURGE_STEP_TIMEOUT_MS = 10_000;

/**
 * How many purges may run at once. Each holds a pooled database connection
 * (with the Source's advisory lock) for its whole run, so the limit keeps a
 * burst of purges from starving the optimize path of connections.
 */
export const MAX_CONCURRENT_PURGES = 2;

/** How long a purge waits for a free slot before it fails with a retryable error. */
export const PURGE_QUEUE_TIMEOUT_MS = 10_000;

/** A Source to purge, with the route class of its active Space. */
export interface PurgedSource extends SourceIdentity {
  /**
   * Which cache prefix can hold the Source's optimized images. The Edge keys
   * them by the Space's route class, which never changes (migration 0000
   * rejects the update), so the other route class's prefix is always empty.
   */
  routeClass: RouteClass;
}

export interface SourcePurge {
  purge(source: PurgedSource): Promise<void>;
}

/** The part of the S3 client the purge depends on: sending list and delete commands. */
export type MediaStoreClient = Pick<S3Client, "send">;

export interface SourcePurgeConfig {
  logger: ControlLogger;
  lifecycle: PreviewJobLifecycle;
  s3: MediaStoreClient;
  bucket: string;
  cloudflareZoneId: string;
  cloudflareApiToken: string;
  edgeBaseUrl: string;
  edgeAuthToken: string;
  fetch: typeof globalThis.fetch;
}

async function deletePrefix(s3: MediaStoreClient, bucket: string, prefix: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
      { abortSignal: AbortSignal.timeout(PURGE_STEP_TIMEOUT_MS) },
    );
    const objects = (page.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [{ Key: object.Key }],
    );
    if (objects.length > 0) {
      const deleted = await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
        { abortSignal: AbortSignal.timeout(PURGE_STEP_TIMEOUT_MS) },
      );
      if ((deleted.Errors?.length ?? 0) > 0) throw new Error("media store deletion failed");
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && continuationToken === undefined)
      throw new Error("media store listing pagination failed");
  } while (continuationToken !== undefined);
}

/**
 * Admits at most `limit` runs at once and queues the rest in arrival order. A
 * finishing run hands its slot straight to the next in line, so a newcomer
 * cannot overtake the queue. A queued run that waits longer than `maxWaitMs`
 * is rejected.
 */
function concurrencyLimit({ limit, maxWaitMs }: { limit: number; maxWaitMs: number }) {
  let active = 0;
  const queue: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = queue.indexOf(grant);
        if (index !== -1) queue.splice(index, 1);
        reject(new Error("source purge queue wait exceeded"));
      }, maxWaitMs);
      timer.unref();
      queue.push(grant);
    });
  };

  const release = () => {
    const next = queue.shift();
    if (next === undefined) {
      active -= 1;
    } else {
      next();
    }
  };

  return async function run<T>(work: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await work();
    } finally {
      release();
    }
  };
}

async function purgeEdgeCache(config: SourcePurgeConfig, tag: string): Promise<void> {
  const response = await config.fetch(new URL("/internal/v1/cache/purge", config.edgeBaseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.edgeAuthToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tags: [tag] }),
    signal: AbortSignal.timeout(PURGE_STEP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("worker cache purge failed");
}

async function purgeZoneTag(config: SourcePurgeConfig, tag: string): Promise<void> {
  const response = await config.fetch(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(config.cloudflareZoneId)}/purge_cache`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.cloudflareApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tags: [tag] }),
      signal: AbortSignal.timeout(PURGE_STEP_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error("cache tag purge failed");
  let result: JsonValue;
  try {
    result = await response.json();
  } catch {
    throw new Error("cache tag purge failed");
  }
  if (!purgeSucceededSchema.safeParse(result).success) {
    throw new Error("cache tag purge failed");
  }
}

export function createSourcePurge(config: SourcePurgeConfig): SourcePurge {
  const limited = concurrencyLimit({
    limit: MAX_CONCURRENT_PURGES,
    maxWaitMs: PURGE_QUEUE_TIMEOUT_MS,
  });

  return {
    async purge(source) {
      try {
        await limited(() =>
          config.lifecycle.withInvalidatedSource(source, async () => {
            // The two prefixes hold different objects, so they are deleted side
            // by side; both finish before the edge purges start, so a
            // concurrent edge request cannot refill a purged cache from R2.
            const prefixes = await Promise.all([
              buildR2CachePurgePrefix(source.routeClass, source.spaceId, source.sourceId),
              buildMasterPurgePrefix(source.spaceId, source.sourceId),
            ]);
            await Promise.all(
              prefixes.map((prefix) => deletePrefix(config.s3, config.bucket, prefix)),
            );

            // The two edge purges clear separate stores: the Edge route clears
            // Workers Caching, which the Edge does not enable, and the zone
            // purge clears the Cache API entries (ADR 0031). Neither refills
            // the other, so they run side by side, and both are waited on so
            // no request outlives the purge. If Workers Caching is enabled in
            // front of the Worker, the zone purge must finish first instead.
            const tag = await buildSourceCacheTag(source.spaceId, source.sourceId);
            const purges = await Promise.allSettled([
              purgeEdgeCache(config, tag),
              purgeZoneTag(config, tag),
            ]);
            for (const purge of purges) {
              if (purge.status === "rejected") throw purge.reason;
            }
          }),
        );
        config.logger.emit(
          "info",
          await operationalEvent({
            event: "control.purge.completed",
            spaceId: source.spaceId,
            sourceId: source.sourceId,
            fields: { outcome: "ready" },
          }),
        );
      } catch (error) {
        config.logger.emit(
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
