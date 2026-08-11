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
    const fetch = vi.fn<typeof globalThis.fetch>(() => response);
    vi.stubGlobal("fetch", fetch);
    const first = executionContext();
    const second = executionContext();

    const firstRead = getEdgeConfig(bindings, first.context);
    const secondRead = getEdgeConfig(bindings, second.context);
    expect(fetch).toHaveBeenCalledOnce();
    resolveResponse(Response.json(wire(1)));

    await expect(firstRead).resolves.toMatchObject({ generation: 1 });
    await expect(secondRead).resolves.toMatchObject({ generation: 1 });
    const init = fetch.mock.calls[0]?.[1];
    expect(init).toMatchObject({ cache: "no-store", redirect: "manual" });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${bindings.EDGE_CONFIG_TOKEN}`,
    );
  });

  it("uses a 45-second snapshot while one background refresh runs", async () => {
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(wire(1)))
      .mockResolvedValueOnce(Response.json(wire(2, START + 46_000)));
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
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(wire(1)))
      .mockRejectedValue(new Error("Control unavailable"));
    vi.stubGlobal("fetch", fetch);
    await getEdgeConfig(bindings, executionContext().context);

    now += 61_000;
    await expect(getEdgeConfig(bindings, executionContext().context)).resolves.toMatchObject({
      generation: 1,
    });
    await expect(getEdgeConfig(bindings, executionContext().context)).resolves.toMatchObject({
      generation: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(3);

    now = START + 10 * 60_000;
    await expect(getEdgeConfig(bindings, executionContext().context)).rejects.toBeInstanceOf(
      EdgeConfigUnavailableError,
    );
  });

  it("rejects an oversized cold snapshot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(1024 * 1024 + 1))),
    );
    await expect(getEdgeConfig(bindings, executionContext().context)).rejects.toBeInstanceOf(
      EdgeConfigUnavailableError,
    );
  });

  it("rejects a snapshot that Control generated outside the failure window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(wire(1, START - 10 * 60_000))),
    );
    await expect(getEdgeConfig(bindings, executionContext().context)).rejects.toBeInstanceOf(
      EdgeConfigUnavailableError,
    );
  });

  it("does not serve a recently fetched snapshot after its generatedAt grace expires", async () => {
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(wire(1, START - 599_000)))
      .mockRejectedValueOnce(new Error("Control unavailable"));
    vi.stubGlobal("fetch", fetch);
    await getEdgeConfig(bindings, executionContext().context);

    now += 2_000;
    await expect(getEdgeConfig(bindings, executionContext().context)).rejects.toBeInstanceOf(
      EdgeConfigUnavailableError,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts a cold refresh after the short timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockReturnValue(START);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
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
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(wire(1)));
    vi.stubGlobal("fetch", fetch);
    await getEdgeConfig(bindings, executionContext().context);
    resetEdgeConfigForTest();
    await getEdgeConfig(bindings, executionContext().context);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
