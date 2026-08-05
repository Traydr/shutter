import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { parseCapabilityKeyRegistry } from "@shutter/protocol";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { createControlRoutes } from "./app.js";
import { ControlConfig } from "./env/server.js";
import { ExecutorDispatch } from "./executor-dispatch.js";
import { Imgproxy } from "./imgproxy.js";
import { ControlLogger, ControlLoggingLive } from "./logging.js";
import { MasterStore } from "./master-store.js";
import { RecoveryLive } from "./recovery.js";
import {
  RenditionJobLifecycle,
  unavailableRenditionJobLifecycle,
} from "./rendition-job-lifecycle.js";
import { SourcePurge } from "./source-purge.js";

function parseStringRegistry(value: string | undefined): Map<string, readonly string[]> {
  if (value === undefined) return new Map();
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return new Map(
    Object.entries(parsed).map(([spaceId, entry]) => [
      spaceId,
      Array.isArray(entry)
        ? entry.filter((candidate): candidate is string => typeof candidate === "string")
        : typeof entry === "string"
          ? [entry]
          : [],
    ]),
  );
}

function parseCapabilityKeys(value: string | undefined) {
  if (value === undefined) return new Map<string, ReadonlyMap<string, Uint8Array>>();
  return new Map(parseCapabilityKeyRegistry(value));
}

const DatabaseLive = Layer.unwrap(
  Effect.map(ControlConfig, (config) => {
    if (config.databaseUrl === undefined) {
      return Layer.succeed(RenditionJobLifecycle)(unavailableRenditionJobLifecycle());
    }
    return RenditionJobLifecycle.layer.pipe(
      Layer.provide(PgClient.layer({ url: Redacted.make(config.databaseUrl) })),
    );
  }),
);

const RoutesLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ControlConfig;
    const logger = yield* ControlLogger;
    const lifecycle = yield* RenditionJobLifecycle;
    const dispatch = yield* ExecutorDispatch;
    const imgproxy = yield* Imgproxy;
    const masterStore = yield* MasterStore;
    const sourcePurge = yield* SourcePurge;
    return createControlRoutes({
      logger,
      originAuthToken: () => config.originAuthToken,
      imgproxy,
      fetch: globalThis.fetch,
      masterStore,
      jobApiRuntime: {
        logger,
        lifecycle,
        now: () => new Date(),
        spaceApiTokens: () => parseStringRegistry(config.spaceApiTokens),
        capabilityKeys: () => parseCapabilityKeys(config.capabilityKeys),
        executorToken: (kind) =>
          kind === "video" ? config.videoExecutorToken : config.pdfExecutorToken,
        dispatch: dispatch.dispatch,
        sourcePurge,
      },
    });
  }),
);

const ServerLive = Layer.unwrap(
  Effect.map(ControlConfig, (config) => NodeHttpServer.layer(createServer, { port: config.port })),
);

const ConfigAndLogging = ControlLoggingLive.pipe(Layer.provideMerge(ControlConfig.layer));
const WithDatabase = DatabaseLive.pipe(Layer.provideMerge(ConfigAndLogging));
const CoreServices = Layer.mergeAll(ExecutorDispatch.layer, Imgproxy.layer, MasterStore.layer).pipe(
  Layer.provideMerge(WithDatabase),
);
const AllServices = SourcePurge.layer.pipe(Layer.provideMerge(CoreServices));

const HttpLive = HttpRouter.serve(RoutesLive).pipe(Layer.provide(ServerLive));
const StartedLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const logger = yield* ControlLogger;
    yield* logger.emit("info", { event: "control.service.started", outcome: "ready" });
  }),
);

export const MainLayer = Layer.mergeAll(HttpLive, RecoveryLive, StartedLive).pipe(
  Layer.provide(AllServices),
);

NodeRuntime.runMain(Layer.launch(MainLayer));
