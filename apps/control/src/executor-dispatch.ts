import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  EXECUTOR_WAKE_ROUTE,
  type ExecutorInvocationResult,
  type OperationalEvent,
  operationalErrorType,
  type PreviewKind,
  parseExecutorWakeReply,
} from "@shutter/protocol";
import type { ControlLogger } from "./logging.js";

/** The status and text body of one wake response. */
export interface WakeReply {
  status: number;
  body: string;
}

/** Sends one authenticated wake POST; rejects on a connection failure or an abort. */
export type WakeRequest = (input: {
  url: URL;
  token: string;
  signal: AbortSignal;
}) => Promise<WakeReply>;

/**
 * The pauses between attempts of one wake. Railway answers the first request
 * to a sleeping service with a refused connection or a `502` while it boots
 * (about six seconds), so a wake keeps knocking for about half a minute.
 */
export const WAKE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/**
 * A drain ends after this many wakes even while the Executor keeps answering
 * `processed`, so no fault can wake it forever; the next sweep or submission
 * starts a fresh drain.
 */
export const MAX_WAKES_PER_DRAIN = 500;

const MAX_WAKE_REPLY_BYTES = 4_096;

/**
 * `202` is a pre-drain Executor that was already busy; `502` and `503` are a
 * service that is still starting or briefly unable to claim.
 */
const RETRYABLE_STATUSES = new Set([202, 502, 503]);

/** What a failed wake attempt saw: an HTTP status, or the class of error before any arrived. */
export type WakeFault = { status: number } | { errorType: string };

/** One wake attempt. `unavailable` is worth retrying; `refused` is not. */
export type WakeAttempt =
  | { outcome: "completed"; result: ExecutorInvocationResult }
  | { outcome: "unavailable"; fault: WakeFault }
  | { outcome: "refused"; fault: WakeFault };

/** One wake, after its retries. */
export type WakeOutcome =
  | { outcome: "completed"; result: ExecutorInvocationResult; attempts: number }
  | { outcome: "failed"; fault: WakeFault; attempts: number };

export interface WakeTarget {
  baseUrl: string;
  token: string;
  request: WakeRequest;
  /** How long one attempt may wait for its invocation to finish. */
  timeoutMs: number;
  /** Aborts the wake, as Control shuts down. */
  signal: AbortSignal;
}

/** The result a `200` wake reply names, or `undefined` for a malformed one. */
function wakeResult(body: string): ExecutorInvocationResult | undefined {
  try {
    return parseExecutorWakeReply(JSON.parse(body)).result;
  } catch {
    return undefined;
  }
}

/** One wake attempt: `POST` to the Executor's wake route, classified. Never rejects. */
export async function sendExecutorWake(target: WakeTarget): Promise<WakeAttempt> {
  const timeout = AbortSignal.timeout(target.timeoutMs);
  let reply: WakeReply;

  try {
    reply = await target.request({
      url: new URL(EXECUTOR_WAKE_ROUTE, target.baseUrl),
      token: target.token,
      signal: AbortSignal.any([target.signal, timeout]),
    });
  } catch (error) {
    const fault = { errorType: operationalErrorType(error) };

    // A wake that ran out its own time held a job all along: that is not a
    // cold start, and the job is its lease's to recover.
    return target.signal.aborted || timeout.aborted
      ? { outcome: "refused", fault }
      : { outcome: "unavailable", fault };
  }

  if (reply.status === 200) {
    const result = wakeResult(reply.body);

    return result === undefined
      ? { outcome: "refused", fault: { status: reply.status } }
      : { outcome: "completed", result };
  }

  return RETRYABLE_STATUSES.has(reply.status)
    ? { outcome: "unavailable", fault: { status: reply.status } }
    : { outcome: "refused", fault: { status: reply.status } };
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(done, ms);

    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }

    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * One wake, retried with backoff while the Executor is unreachable or still
 * starting. A `401`, any other `4xx`, a `500`, a malformed reply, or a wake
 * that outlived its timeout is not retried.
 */
export async function wakeExecutor(
  target: WakeTarget,
  retryDelaysMs: readonly number[] = WAKE_RETRY_DELAYS_MS,
): Promise<WakeOutcome> {
  let attempts = 0;

  for (;;) {
    const attempt = await sendExecutorWake(target);
    attempts += 1;

    if (attempt.outcome === "completed") {
      return { outcome: "completed", result: attempt.result, attempts };
    }

    const delay = retryDelaysMs[attempts - 1];

    if (attempt.outcome === "refused" || delay === undefined) {
      return { outcome: "failed", fault: attempt.fault, attempts };
    }

    await pause(delay, target.signal);

    if (target.signal.aborted) return { outcome: "failed", fault: attempt.fault, attempts };
  }
}

/**
 * The production wake transport. A wake's reply arrives only when its
 * invocation ends, up to the ten-minute attempt deadline later: `node:http`
 * has no response-header timeout, where Node's `fetch` gives up after 300
 * seconds. A fresh connection per wake (`agent: false`) leaves no idle
 * keep-alive socket to an Executor that should be going back to sleep, and
 * TCP keepalive keeps a long, silent wake from being dropped on the way.
 */
export const nodeWakeRequest: WakeRequest = ({ url, token, signal }) =>
  new Promise<WakeReply>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(
      url,
      {
        method: "POST",
        agent: false,
        signal,
        headers: { authorization: `Bearer ${token}`, "content-length": "0" },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;

        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;

          if (bytes > MAX_WAKE_REPLY_BYTES) {
            outgoing.destroy(new Error("wake reply is too large"));
            return;
          }

          chunks.push(chunk);
        });
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        incoming.on("error", reject);
      },
    );

    outgoing.on("socket", (socket) => socket.setKeepAlive(true, 60_000));
    outgoing.on("error", reject);
    outgoing.end();
  });

/** Wakes one Executor kind once, retries included. */
export type ExecutorWake = (kind: PreviewKind, signal: AbortSignal) => Promise<WakeOutcome>;

/** How a drain ended: the Executor found no work, the wake limit was reached, or a wake failed. */
export type DrainOutcome = { outcome: "idle" | "limited" | "failed"; wakes: number };

export interface ExecutorDrains {
  /**
   * Keeps waking `kind` while its Executor answers `processed` and stops on
   * `idle`. A request while that kind is already draining joins the drain in
   * flight and makes it wake once more before it can stop, so a job
   * submitted mid-drain is never left behind. Never rejects; a failure is
   * logged here once per drain.
   */
  drain(kind: PreviewKind): Promise<DrainOutcome>;
  /** Aborts wakes in flight and refuses new drains, as Control shuts down. */
  close(): void;
}

function failureEvent(kind: PreviewKind, fault: WakeFault, attempts: number): OperationalEvent {
  const event: OperationalEvent = {
    event: "control.dispatch.failed",
    kind,
    outcome: "failed",
    failureCode: "service_unavailable",
    count: attempts,
  };

  if ("status" in fault) event.httpStatusCode = fault.status;
  else event.errorType = fault.errorType;

  return event;
}

export function createExecutorDrains({
  logger,
  wake,
  maxWakes = MAX_WAKES_PER_DRAIN,
}: {
  logger: ControlLogger;
  wake: ExecutorWake;
  maxWakes?: number;
}): ExecutorDrains {
  const closing = new AbortController();
  const inFlight = new Map<PreviewKind, Promise<DrainOutcome>>();
  const requestedAgain = new Set<PreviewKind>();

  async function wakeOnce(kind: PreviewKind): Promise<WakeOutcome> {
    try {
      return await wake(kind, closing.signal);
    } catch (error) {
      return { outcome: "failed", fault: { errorType: operationalErrorType(error) }, attempts: 0 };
    }
  }

  async function drainUntilIdle(kind: PreviewKind): Promise<DrainOutcome> {
    let wakes = 0;

    // The loop decides to stop and leaves `inFlight` in one synchronous step,
    // so a request can only join a drain that will still wake again.
    try {
      while (wakes < maxWakes) {
        requestedAgain.delete(kind);
        const startedAt = performance.now();
        const woken = await wakeOnce(kind);

        if (woken.outcome === "failed") {
          if (!closing.signal.aborted) {
            logger.emit("error", failureEvent(kind, woken.fault, woken.attempts));
          }

          return { outcome: "failed", wakes };
        }

        wakes += 1;
        logger.emit("info", {
          event: "control.executor.delegated",
          kind,
          outcome: woken.result === "processed" ? "ready" : "idle",
          durationMs: Math.round(performance.now() - startedAt),
          count: woken.attempts,
        });

        if (woken.result === "idle" && !requestedAgain.has(kind)) return { outcome: "idle", wakes };
      }

      return { outcome: "limited", wakes };
    } finally {
      inFlight.delete(kind);
      requestedAgain.delete(kind);
    }
  }

  return {
    drain(kind) {
      const current = inFlight.get(kind);

      if (current !== undefined) {
        requestedAgain.add(kind);

        return current;
      }

      if (closing.signal.aborted) return Promise.resolve({ outcome: "failed", wakes: 0 });

      // Registered before the loop's first step runs, so the loop's `finally`
      // always removes its own entry.
      const started = Promise.resolve().then(() => drainUntilIdle(kind));
      inFlight.set(kind, started);

      return started;
    },
    close() {
      closing.abort();
    },
  };
}
