import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  buildMasterPurgePrefix,
  buildR2CachePurgePrefix,
  buildSourceCacheTag,
  operationalEvent,
} from "@shutter/protocol";
import { Context, Data, Effect, Layer, Option, Stream } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { ControlConfig } from "./env/server.js";
import { ControlLogger, type ControlLoggerShape } from "./logging.js";
import {
  RenditionJobLifecycle,
  type RenditionJobLifecycleShape,
  type SourceIdentity,
} from "./rendition-job-lifecycle.js";

export class SourcePurgeError extends Data.TaggedError("SourcePurgeError")<{
  readonly reason:
    | "not_configured"
    | "storage_request_failed"
    | "storage_delete_failed"
    | "storage_pagination_failed"
    | "worker_purge_failed"
    | "zone_purge_failed";
  readonly cause?: unknown;
}> {}

export interface SourcePurgeShape {
  purge(source: SourceIdentity): Effect.Effect<void, SourcePurgeError | SqlError>;
}

export class SourcePurge extends Context.Service<SourcePurge, SourcePurgeShape>()(
  "@shutter/control/SourcePurge",
) {
  static readonly layer = Layer.effect(
    SourcePurge,
    Effect.gen(function* () {
      const config = yield* ControlConfig;
      const logger = yield* ControlLogger;
      const lifecycle = yield* RenditionJobLifecycle;
      if (
        config.s3Endpoint === undefined ||
        config.s3Bucket === undefined ||
        config.s3AccessKeyId === undefined ||
        config.s3SecretAccessKey === undefined ||
        config.cloudflareZoneId === undefined ||
        config.cloudflareCachePurgeToken === undefined ||
        config.edgeBaseUrl === undefined ||
        config.originAuthToken === undefined
      ) {
        return SourcePurge.of({
          purge: () => Effect.fail(new SourcePurgeError({ reason: "not_configured" })),
        });
      }
      const s3 = new S3Client({
        endpoint: config.s3Endpoint,
        region: config.s3Region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.s3AccessKeyId,
          secretAccessKey: config.s3SecretAccessKey,
        },
      });
      return createSourcePurge({
        logger,
        lifecycle,
        s3,
        bucket: config.s3Bucket,
        cloudflareZoneId: config.cloudflareZoneId,
        cloudflareApiToken: config.cloudflareCachePurgeToken,
        edgeBaseUrl: config.edgeBaseUrl,
        edgeAuthToken: config.originAuthToken,
        fetch: globalThis.fetch,
      });
    }),
  );
}

export interface SourcePurgeConfig {
  logger: ControlLoggerShape;
  lifecycle: RenditionJobLifecycleShape;
  s3: S3Client;
  bucket: string;
  cloudflareZoneId: string;
  cloudflareApiToken: string;
  edgeBaseUrl: string;
  edgeAuthToken: string;
  fetch: typeof globalThis.fetch;
}

function s3Request<A>(request: () => Promise<A>): Effect.Effect<A, SourcePurgeError> {
  return Effect.tryPromise({
    try: request,
    catch: (cause) => new SourcePurgeError({ reason: "storage_request_failed", cause }),
  });
}

function deletePrefix(s3: S3Client, bucket: string, prefix: string) {
  return Stream.paginate(undefined as string | undefined, (continuationToken) =>
    Effect.gen(function* () {
      const page = yield* s3Request(() =>
        s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
          }),
        ),
      );
      const objects = (page.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [{ Key: object.Key }],
      );
      if (objects.length > 0) {
        const deleted = yield* s3Request(() =>
          s3.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects, Quiet: true },
            }),
          ),
        );
        if ((deleted.Errors?.length ?? 0) > 0) {
          return yield* Effect.fail(new SourcePurgeError({ reason: "storage_delete_failed" }));
        }
      }
      const next = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && next === undefined) {
        return yield* Effect.fail(new SourcePurgeError({ reason: "storage_pagination_failed" }));
      }
      return [[], next === undefined ? Option.none() : Option.some(next)] as const;
    }),
  ).pipe(Stream.runDrain);
}

function fetchRequest(
  fetch: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  reason: "worker_purge_failed" | "zone_purge_failed",
) {
  return Effect.tryPromise({
    try: (signal) => fetch(input, { ...init, signal }),
    catch: (cause) => new SourcePurgeError({ reason, cause }),
  });
}

export function createSourcePurge(config: SourcePurgeConfig): SourcePurgeShape {
  return SourcePurge.of({
    purge(source) {
      const purge = Effect.gen(function* () {
        yield* config.lifecycle.withInvalidatedSource(
          source,
          Effect.gen(function* () {
            const prefixes = yield* Effect.all([
              Effect.promise(() =>
                buildR2CachePurgePrefix("public", source.spaceId, source.sourceId),
              ),
              Effect.promise(() =>
                buildR2CachePurgePrefix("private", source.spaceId, source.sourceId),
              ),
              Effect.promise(() => buildMasterPurgePrefix(source.spaceId, source.sourceId)),
            ]);
            // R2 must be empty before either edge cache is purged. Reordering
            // these stages permits a concurrent edge miss to repopulate cache.
            yield* Effect.forEach(
              prefixes,
              (prefix) => deletePrefix(config.s3, config.bucket, prefix),
              { discard: true },
            );

            const tag = yield* Effect.promise(() =>
              buildSourceCacheTag(source.spaceId, source.sourceId),
            );
            const edgePurge = yield* fetchRequest(
              config.fetch,
              new URL("/internal/v1/cache/purge", config.edgeBaseUrl),
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${config.edgeAuthToken}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ tags: [tag] }),
              },
              "worker_purge_failed",
            );
            if (!edgePurge.ok) {
              return yield* Effect.fail(new SourcePurgeError({ reason: "worker_purge_failed" }));
            }

            const response = yield* fetchRequest(
              config.fetch,
              `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(config.cloudflareZoneId)}/purge_cache`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${config.cloudflareApiToken}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ tags: [tag] }),
              },
              "zone_purge_failed",
            );
            if (!response.ok) {
              return yield* Effect.fail(new SourcePurgeError({ reason: "zone_purge_failed" }));
            }
            const result = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (cause) => new SourcePurgeError({ reason: "zone_purge_failed", cause }),
            });
            if (
              typeof result !== "object" ||
              result === null ||
              !("success" in result) ||
              result.success !== true
            ) {
              return yield* Effect.fail(new SourcePurgeError({ reason: "zone_purge_failed" }));
            }
          }),
        );
        yield* operationalEvent({
          event: "control.purge.completed",
          spaceId: source.spaceId,
          sourceId: source.sourceId,
          fields: { outcome: "ready" },
        }).pipe(Effect.flatMap((event) => config.logger.emit("info", event)));
      });

      return purge.pipe(
        Effect.tapCause(() =>
          operationalEvent({
            event: "control.purge.failed",
            spaceId: source.spaceId,
            sourceId: source.sourceId,
            fields: { outcome: "failed", failureCode: "service_unavailable" },
          }).pipe(Effect.flatMap((event) => config.logger.emit("error", event))),
        ),
      );
    },
  });
}
