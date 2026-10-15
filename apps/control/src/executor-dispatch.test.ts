import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { OperationalEvent, PreviewKind } from "@shutter/protocol";
import { EXECUTOR_WAKE_FIXTURE } from "@shutter/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecutorDrains,
  type ExecutorWake,
  nodeWakeRequest,
  type WakeOutcome,
  type WakeReply,
  type WakeRequest,
  wakeExecutor,
} from "./executor-dispatch.js";
import type { ControlLogger, OperationalLogLevel } from "./logging.js";

const TOKEN = "x".repeat(32);

function recordingLogger() {
  const entries: { level: OperationalLogLevel; event: OperationalEvent }[] = [];
  const logger: ControlLogger = {
    emit(level, event) {
      entries.push({ level, event });
    },
    async shutdown() {},
  };

  return { logger, entries };
}

/** A wake transport that answers from a script, recording when each attempt was sent. */
function scriptedRequest(script: readonly (WakeReply | Error)[]) {
  const sentAt: number[] = [];
  const requests: { url: string; token: string }[] = [];
  const request: WakeRequest = async ({ url, token }) => {
    sentAt.push(Date.now());
    requests.push({ url: url.toString(), token });
    const next = script[Math.min(sentAt.length - 1, script.length - 1)];
    if (next === undefined || next instanceof Error) throw next ?? new Error("script is empty");

    return next;
  };

  return { request, sentAt, requests };
}

function target(request: WakeRequest, signal = new AbortController().signal) {
  return { baseUrl: "http://executor.test:3000", token: TOKEN, request, timeoutMs: 60_000, signal };
}

const reply = (status: number, body = ""): WakeReply => ({ status, body });
const processed = reply(200, EXECUTOR_WAKE_FIXTURE.replies.processed);
const idle = reply(200, EXECUTOR_WAKE_FIXTURE.replies.idle);

describe("executor wake", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts the wake and reads what the invocation did", async () => {
    const { request, requests } = scriptedRequest([processed]);

    await expect(wakeExecutor(target(request))).resolves.toEqual({
      outcome: "completed",
      result: "processed",
      attempts: 1,
    });
    expect(requests).toEqual([
      { url: `http://executor.test:3000${EXECUTOR_WAKE_FIXTURE.route}`, token: TOKEN },
    ]);
  });

  it("keeps knocking on a cold Executor with backoff until it answers", async () => {
    vi.useFakeTimers({ now: 0 });
    const { request, sentAt } = scriptedRequest([
      new Error("connect ECONNREFUSED"),
      new Error("socket hang up"),
      reply(502),
      reply(503),
      idle,
    ]);

    const woken = wakeExecutor(target(request));
    await vi.runAllTimersAsync();

    await expect(woken).resolves.toEqual({ outcome: "completed", result: "idle", attempts: 5 });
    expect(sentAt).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
  });

  it("gives up after about half a minute of a service that never starts", async () => {
    vi.useFakeTimers({ now: 0 });
    const { request, sentAt } = scriptedRequest([reply(502)]);

    const woken = wakeExecutor(target(request));
    await vi.runAllTimersAsync();

    await expect(woken).resolves.toEqual({
      outcome: "failed",
      fault: { status: 502 },
      attempts: 6,
    });
    expect(sentAt).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000]);
  });

  it("retries the busy answer of an Executor that predates draining", async () => {
    vi.useFakeTimers({ now: 0 });
    const { request } = scriptedRequest([
      reply(202, JSON.stringify({ result: "busy" })),
      processed,
    ]);

    const woken = wakeExecutor(target(request));
    await vi.runAllTimersAsync();

    await expect(woken).resolves.toEqual({
      outcome: "completed",
      result: "processed",
      attempts: 2,
    });
  });

  it.each([
    ["an unauthorized wake", reply(401)],
    ["any other client error", reply(404)],
    ["an Executor fault", reply(500)],
    ...EXECUTOR_WAKE_FIXTURE.malformedReplies.map((body): [string, WakeReply] => [
      `the malformed reply ${body}`,
      reply(200, body),
    ]),
  ])("does not retry %s", async (_name, answer) => {
    const { request, sentAt } = scriptedRequest([answer, processed]);

    await expect(wakeExecutor(target(request))).resolves.toEqual({
      outcome: "failed",
      fault: { status: answer.status },
      attempts: 1,
    });
    expect(sentAt).toHaveLength(1);
  });

  it("does not retry a wake that outlived its timeout", async () => {
    const request: WakeRequest = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    await expect(wakeExecutor({ ...target(request), timeoutMs: 5 })).resolves.toEqual({
      outcome: "failed",
      fault: { errorType: "TimeoutError" },
      attempts: 1,
    });
  });

  it("stops retrying when Control shuts down", async () => {
    vi.useFakeTimers({ now: 0 });
    const shutdown = new AbortController();
    const { request, sentAt } = scriptedRequest([reply(503)]);

    const woken = wakeExecutor(target(request, shutdown.signal));
    await vi.advanceTimersByTimeAsync(1_500);
    shutdown.abort();

    await expect(woken).resolves.toEqual({
      outcome: "failed",
      fault: { status: 503 },
      attempts: 2,
    });
    expect(sentAt).toEqual([0, 1_000]);
  });
});

describe("node wake transport", () => {
  async function listen(
    handler: Parameters<typeof createServer>[1],
  ): Promise<{ url: URL; close(): Promise<void> }> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
    const { port } = server.address() as AddressInfo;

    return {
      url: new URL(`http://127.0.0.1:${port}/internal/v1/run-once`),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("sends the bearer token on a connection it does not keep alive", async () => {
    let received: IncomingHttpHeaders | undefined;
    let method: string | undefined;
    const server = await listen((request, response) => {
      received = request.headers;
      method = request.method;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: "idle" }));
    });

    try {
      await expect(
        nodeWakeRequest({ url: server.url, token: TOKEN, signal: new AbortController().signal }),
      ).resolves.toEqual({ status: 200, body: '{"result":"idle"}' });
      expect(method).toBe("POST");
      expect(received?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(received?.connection).toBe("close");
    } finally {
      await server.close();
    }
  });

  it("brings a wake through a reset and a 502 to the Executor's answer", async () => {
    let requests = 0;
    const server = await listen((request, response) => {
      requests += 1;
      if (requests === 1) {
        request.socket.destroy();
        return;
      }

      if (requests === 2) {
        response.writeHead(502).end();
        return;
      }

      response.writeHead(200).end(JSON.stringify({ result: "processed" }));
    });

    try {
      await expect(
        wakeExecutor(
          {
            baseUrl: server.url.origin,
            token: TOKEN,
            request: nodeWakeRequest,
            timeoutMs: 5_000,
            signal: new AbortController().signal,
          },
          [1, 1, 1],
        ),
      ).resolves.toEqual({ outcome: "completed", result: "processed", attempts: 3 });
    } finally {
      await server.close();
    }
  });

  it("rejects when nothing is listening, which a wake retries", async () => {
    const server = await listen((_request, response) => response.end());
    await server.close();

    await expect(
      nodeWakeRequest({ url: server.url, token: TOKEN, signal: new AbortController().signal }),
    ).rejects.toThrow(/ECONNREFUSED/u);
  });
});

/** A wake whose answers the test releases one at a time. */
function controlledWake() {
  const pending: { kind: PreviewKind; settle(outcome: WakeOutcome): void }[] = [];
  const signals: AbortSignal[] = [];
  const wake: ExecutorWake = (kind, signal) =>
    new Promise((resolve) => {
      signals.push(signal);
      pending.push({ kind, settle: resolve });
    });
  const answer = async (outcome: WakeOutcome) => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    pending.shift()?.settle(outcome);
  };

  return { wake, pending, signals, answer };
}

const completed = (result: "processed" | "idle", attempts = 1): WakeOutcome => ({
  outcome: "completed",
  result,
  attempts,
});

describe("executor drains", () => {
  it("keeps waking while the Executor processes jobs and stops when it is idle", async () => {
    const { logger, entries } = recordingLogger();
    const answers = [completed("processed", 3), completed("processed"), completed("idle")];
    const wake = vi.fn<ExecutorWake>(async () => answers.shift() ?? completed("idle"));
    const drains = createExecutorDrains({ logger, wake });

    await expect(drains.drain("video")).resolves.toEqual({ outcome: "idle", wakes: 3 });

    expect(wake).toHaveBeenCalledTimes(3);
    expect(
      entries.map(({ level, event }) => ({ level, outcome: event.outcome, count: event.count })),
    ).toEqual([
      { level: "info", outcome: "ready", count: 3 },
      { level: "info", outcome: "ready", count: 1 },
      { level: "info", outcome: "idle", count: 1 },
    ]);
    expect(entries.every(({ event }) => event.event === "control.executor.delegated")).toBe(true);
  });

  it("coalesces requests into the drain in flight and wakes once more for them", async () => {
    const { logger } = recordingLogger();
    const { wake, pending, answer } = controlledWake();
    const drains = createExecutorDrains({ logger, wake });

    const first = drains.drain("pdf");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const joined = Array.from({ length: 5 }, () => drains.drain("pdf"));
    expect(joined.every((promise) => promise === first)).toBe(true);

    // The first wake's claim may have run before those submissions committed,
    // so its `idle` cannot end the drain.
    await answer(completed("idle"));
    await answer(completed("idle"));

    await expect(first).resolves.toEqual({ outcome: "idle", wakes: 2 });
    expect(pending).toHaveLength(0);
  });

  it("starts a fresh drain for a request after the last one ended", async () => {
    const { logger } = recordingLogger();
    const wake = vi.fn<ExecutorWake>(async () => completed("idle"));
    const drains = createExecutorDrains({ logger, wake });

    await drains.drain("video");
    await drains.drain("video");

    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("ends a drain at its wake limit", async () => {
    const { logger } = recordingLogger();
    const wake = vi.fn<ExecutorWake>(async () => completed("processed"));
    const drains = createExecutorDrains({ logger, wake, maxWakes: 3 });

    await expect(drains.drain("video")).resolves.toEqual({ outcome: "limited", wakes: 3 });
    expect(wake).toHaveBeenCalledTimes(3);
  });

  it("logs a failed drain once, with what the last attempt saw", async () => {
    const { logger, entries } = recordingLogger();
    const wake = vi.fn<ExecutorWake>(async () => ({
      outcome: "failed",
      fault: { status: 502 },
      attempts: 6,
    }));
    const drains = createExecutorDrains({ logger, wake });

    const outcomes = await Promise.all([drains.drain("video"), drains.drain("video")]);

    expect(outcomes).toEqual([
      { outcome: "failed", wakes: 0 },
      { outcome: "failed", wakes: 0 },
    ]);
    expect(entries).toEqual([
      {
        level: "error",
        event: {
          event: "control.dispatch.failed",
          kind: "video",
          outcome: "failed",
          failureCode: "service_unavailable",
          count: 6,
          httpStatusCode: 502,
        },
      },
    ]);
  });

  it("treats a wake that throws as a failed drain", async () => {
    const { logger, entries } = recordingLogger();
    const drains = createExecutorDrains({
      logger,
      wake: async () => {
        throw new TypeError("unexpected");
      },
    });

    await expect(drains.drain("pdf")).resolves.toEqual({ outcome: "failed", wakes: 0 });
    expect(entries.map(({ event }) => [event.event, event.errorType])).toEqual([
      ["control.dispatch.failed", "TypeError"],
    ]);
  });

  it("drains each Executor kind independently", async () => {
    const { logger } = recordingLogger();
    const { wake, pending, answer } = controlledWake();
    const drains = createExecutorDrains({ logger, wake });

    const video = drains.drain("video");
    const pdf = drains.drain("pdf");
    await vi.waitFor(() => expect(pending.map(({ kind }) => kind)).toEqual(["video", "pdf"]));

    pending.splice(1, 1)[0]?.settle(completed("idle"));
    await expect(pdf).resolves.toEqual({ outcome: "idle", wakes: 1 });
    expect(pending.map(({ kind }) => kind)).toEqual(["video"]);

    await answer(completed("idle"));
    await expect(video).resolves.toEqual({ outcome: "idle", wakes: 1 });
  });

  it("aborts wakes in flight on close, quietly, and refuses new drains", async () => {
    const { logger, entries } = recordingLogger();
    const { wake, pending, signals } = controlledWake();
    const drains = createExecutorDrains({ logger, wake });

    const draining = drains.drain("video");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    drains.close();
    expect(signals[0]?.aborted).toBe(true);
    pending[0]?.settle({ outcome: "failed", fault: { errorType: "AbortError" }, attempts: 1 });

    await expect(draining).resolves.toEqual({ outcome: "failed", wakes: 0 });
    await expect(drains.drain("video")).resolves.toEqual({ outcome: "failed", wakes: 0 });
    expect(signals).toHaveLength(1);
    expect(entries).toEqual([]);
  });
});
