import {
  CONTROL_HTTP_ROUTES,
  type JsonValue,
  type ParsedEdgeConfigSnapshot,
  parseEdgeConfigSnapshot,
  serializeEdgeConfigRefreshReport,
} from "@shutter/protocol";

const SOFT_REFRESH_MS = 45_000;
const REQUIRED_REFRESH_MS = 60_000;
const FAILURE_GRACE_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
// Wide enough that ordinary NTP drift on Control cannot reject every snapshot
// globally; a snapshot stamped further in the future than this is discarded.
const MAX_CLOCK_SKEW_MS = 60_000;

interface CachedSnapshot {
  snapshot: ParsedEdgeConfigSnapshot;
  fetchedAt: number;
}

/** The part of the Worker's ExecutionContext the snapshot needs: deferring a background refresh. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** The bindings the snapshot reads: where Control lives and how to authenticate to it. */
export type EdgeConfigBindings = Pick<CloudflareBindings, "ORIGIN_BASE_URL" | "EDGE_CONFIG_TOKEN">;

let cached: CachedSnapshot | undefined;
let refreshInFlight: Promise<CachedSnapshot> | undefined;

export class EdgeConfigUnavailableError extends Error {
  constructor() {
    super("Edge configuration is unavailable");
    this.name = "EdgeConfigUnavailableError";
  }
}

async function readLimitedJson(response: Response): Promise<JsonValue> {
  if (response.body === null) throw new EdgeConfigUnavailableError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_SNAPSHOT_BYTES) throw new EdgeConfigUnavailableError();
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new EdgeConfigUnavailableError();
  }
}

async function fetchSnapshot(bindings: EdgeConfigBindings): Promise<CachedSnapshot> {
  const url = new URL(CONTROL_HTTP_ROUTES.edgeConfig, bindings.ORIGIN_BASE_URL);
  // HTTPS only, with one exemption so local development can read config from
  // a Control process on the same machine.
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new EdgeConfigUnavailableError();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${bindings.EDGE_CONFIG_TOKEN}` },
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok || response.redirected || response.status >= 300) {
      throw new EdgeConfigUnavailableError();
    }
    const snapshot = parseEdgeConfigSnapshot(await readLimitedJson(response));
    const now = Date.now();
    if (
      snapshot.generatedAt > now + MAX_CLOCK_SKEW_MS ||
      now - snapshot.generatedAt >= FAILURE_GRACE_MS
    ) {
      throw new EdgeConfigUnavailableError();
    }
    const next = { snapshot, fetchedAt: now };
    cached = next;
    return next;
  } catch (error) {
    if (error instanceof EdgeConfigUnavailableError) throw error;
    throw new EdgeConfigUnavailableError();
  } finally {
    clearTimeout(timeout);
  }
}

function refresh(
  bindings: EdgeConfigBindings,
  executionContext: WaitUntilContext,
): Promise<CachedSnapshot> {
  if (refreshInFlight !== undefined) return refreshInFlight;
  const pending = fetchSnapshot(bindings);
  refreshInFlight = pending;
  executionContext.waitUntil(
    pending
      .then((result) => reportRefresh(bindings, result.snapshot.generation))
      .catch(() => undefined),
  );
  void pending
    .finally(() => {
      if (refreshInFlight === pending) refreshInFlight = undefined;
    })
    .catch(() => undefined);
  return pending;
}

async function reportRefresh(bindings: EdgeConfigBindings, generation: number): Promise<void> {
  const url = new URL(CONTROL_HTTP_ROUTES.edgeConfigRefresh, bindings.ORIGIN_BASE_URL);
  if (url.protocol !== "https:") return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bindings.EDGE_CONFIG_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(serializeEdgeConfigRefreshReport(generation)),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    // Refresh reporting is advisory and cannot make a valid snapshot unavailable.
  } finally {
    clearTimeout(timeout);
  }
}

function withinFailureGrace(snapshot: CachedSnapshot, now: number): boolean {
  return now - snapshot.snapshot.generatedAt < FAILURE_GRACE_MS;
}

export async function getEdgeConfig(
  bindings: EdgeConfigBindings,
  executionContext: WaitUntilContext,
): Promise<ParsedEdgeConfigSnapshot> {
  const now = Date.now();
  if (cached !== undefined && withinFailureGrace(cached, now)) {
    const age = now - cached.fetchedAt;
    if (age < SOFT_REFRESH_MS) return cached.snapshot;
    if (age < REQUIRED_REFRESH_MS) {
      void refresh(bindings, executionContext);
      return cached.snapshot;
    }
  }
  try {
    return (await refresh(bindings, executionContext)).snapshot;
  } catch {
    if (cached !== undefined && withinFailureGrace(cached, Date.now())) return cached.snapshot;
    throw new EdgeConfigUnavailableError();
  }
}

export function resetEdgeConfigForTest(): void {
  cached = undefined;
  refreshInFlight = undefined;
}
