import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EdgeConfigUnavailableError,
  getEdgeConfig,
  resetEdgeConfigForTest,
} from "./config-snapshot.js";

const START = Date.parse("2026-08-11T10:00:00.000Z");
const bindings = {
  ORIGIN_BASE_URL: "https://control.example.test",
  EDGE_CONFIG_TOKEN: "e".repeat(32),
} as CloudflareBindings;

function wire(generation: number, generatedAt = Date.now()): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    generation,
    generatedAt: new Date(generatedAt).toISOString(),
    spaces: [
      {
        id: "example-public",
        routeClass: "public",
        qualities: [75],
        defaultQuality: 75,
        allowedSourceOrigins: [{ origin: "https://sources.example.com" }],
        resolvers: [],
      },
    ],
    capabilityKeys: { "example-public": {} },
  };
}

function executionContext(): {
  context: ExecutionContext;
  pending: Promise<unknown>[];
} {
  const pending: Promise<unknown>[] = [];
  return {
    context: {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext,
    pending,
  };
}

function isRefreshReport(input: RequestInfo | URL): boolean {
  return new URL(input instanceof Request ? input.url : input.toString()).pathname.endsWith(
    "/refresh",
  );
}

function snapshotCalls(fetch: ReturnType<typeof vi.fn>): number {
  return fetch.mock.calls.filter(([input]) => !isRefreshReport(input as RequestInfo | URL)).length;
}

function refreshReportCalls(fetch: ReturnType<typeof vi.fn>): number {
  return fetch.mock.calls.filter(([input]) => isRefreshReport(input as RequestInfo | URL)).length;
}

afterEach(() => {
  resetEdgeConfigForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Edge configuration snapshot", () => {
  it("shares one cold refresh across concurrent requests", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    let resolveResponse: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>((input) =>
      isRefreshReport(input) ? Promise.resolve(new Response(null, { status: 204 })) : response,
    );
    vi.stubGlobal("fetch", fetch);
    const first = executionContext();
    const second = executionContext();

    const firstRead = getEdgeConfig(bindings, first.context);
    const secondRead = getEdgeConfig(bindings, second.context);
    expect(snapshotCalls(fetch)).toBe(1);
    resolveResponse(Response.json(wire(1)));

    await expect(firstRead).resolves.toMatchObject({ generation: 1 });
    await expect(secondRead).resolves.toMatchObject({ generation: 1 });
    expect(first.pending).toHaveLength(1);
    expect(second.pending).toHaveLength(0);
    await Promise.all(first.pending);
    expect(refreshReportCalls(fetch)).toBe(1);
    const init = fetch.mock.calls[0]?.[1];
    expect(init).toMatchObject({ cache: "no-store", redirect: "manual" });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${bindings.EDGE_CONFIG_TOKEN}`,
    );
  });

  it("uses a 45-second snapshot while one background refresh runs", async () => {
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let snapshot = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (isRefreshReport(input)) return new Response(null, { status: 204 });
      snapshot += 1;
      return Response.json(wire(snapshot, snapshot === 1 ? START : START + 46_000));
    });
    vi.stubGlobal("fetch", fetch);
    await getEdgeConfig(bindings, executionContext().context);
    now += 46_000;
    const soft = executionContext();

    await expect(getEdgeConfig(bindings, soft.context)).resolves.toMatchObject({ generation: 1 });
    expect(soft.pending).toHaveLength(1);
    await Promise.all(soft.pending);
    await expect(getEdgeConfig(bindings, executionContext().context)).resolves.toMatchObject({
      generation: 2,
    });
  });

  it("retries failed hard refreshes inside grace and fails closed after ten minutes", async () => {
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let snapshot = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (isRefreshReport(input)) return new Response(null, { status: 204 });
      snapshot += 1;
      if (snapshot === 1) return Response.json(wire(1));
      throw new Error("Control unavailable");
    });
    vi.stubGlobal("fetch", fetch);
    await getEdgeConfig(bindings, executionContext().context);

    now += 61_000;
    await expect(getEdgeConfig(bindings, executionContext().context)).resolves.toMatchObject({
      generation: 1,
    });
    await expect(getEdgeConfig(bindings, executionContext().context)).resolves.toMatchObject({
      generation: 1,
    });
    expect(snapshotCalls(fetch)).toBe(3);

    now = START + 10 * 60_000;
    await expect(getEdgeConfig(bindings, executionContext().context)).rejects.toBeInstanceOf(
      EdgeConfigUnavailableError,
    );
  });

  it("rejects an oversized cold snapshot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) =>
        isRefreshReport(input)
          ? new Response(null, { status: 204 })
          : new Response(new Uint8Array(1024 * 1024 + 1)),
      ),
    );
    await expect(getEdgeConfig(bindings, executionContext().context)).rejects.toBeInstanceOf(
      EdgeConfigUnavailableError,
    );
  });

  it("rejects a snapshot that Control generated outside the failure window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) =>
        isRefreshReport(input)
          ? new Response(null, { status: 204 })
          : Response.json(wire(1, START - 10 * 60_000)),
      ),
    );
    await expect(getEdgeConfig(bindings, executionContext().context)).rejects.toBeInstanceOf(
      EdgeConfigUnavailableError,
    );
  });

  it("does not serve a recently fetched snapshot after its generatedAt grace expires", async () => {
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let snapshot = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (isRefreshReport(input)) return new Response(null, { status: 204 });
      snapshot += 1;
      if (snapshot === 1) return Response.json(wire(1, START - 599_000));
      throw new Error("Control unavailable");
    });
    vi.stubGlobal("fetch", fetch);
    await getEdgeConfig(bindings, executionContext().context);

    now += 2_000;
    await expect(getEdgeConfig(bindings, executionContext().context)).rejects.toBeInstanceOf(
      EdgeConfigUnavailableError,
    );
    expect(snapshotCalls(fetch)).toBe(2);
  });

  it("aborts a cold refresh after the short timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockReturnValue(START);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((input, init) =>
        isRefreshReport(input)
          ? Promise.resolve(new Response(null, { status: 204 }))
          : new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
      ),
    );
    const read = getEdgeConfig(bindings, executionContext().context);
    const assertion = expect(read).rejects.toBeInstanceOf(EdgeConfigUnavailableError);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it("performs a new cold read after isolate state is evicted", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      isRefreshReport(input) ? new Response(null, { status: 204 }) : Response.json(wire(1)),
    );
    vi.stubGlobal("fetch", fetch);
    await getEdgeConfig(bindings, executionContext().context);
    resetEdgeConfigForTest();
    await getEdgeConfig(bindings, executionContext().context);
    expect(snapshotCalls(fetch)).toBe(2);
  });

  it("reports each successful refresh without delaying snapshot use", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (!isRefreshReport(input)) return Response.json(wire(8));
      expect(init).toMatchObject({ method: "POST", cache: "no-store", redirect: "manual" });
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${bindings.EDGE_CONFIG_TOKEN}`,
      );
      expect(init?.body).toBe(JSON.stringify({ generation: 8 }));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);
    const execution = executionContext();
    await expect(getEdgeConfig(bindings, execution.context)).resolves.toMatchObject({
      generation: 8,
    });
    await Promise.all(execution.pending);
    expect(fetch.mock.calls.some(([input]) => isRefreshReport(input))).toBe(true);
  });
});
