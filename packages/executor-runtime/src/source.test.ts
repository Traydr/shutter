import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type ClientRequest, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessingFailure } from "./media.js";
import {
  downloadSource,
  openRangeSource,
  PROXY_BUDGET_SLACK_BYTES,
  PROXY_MAX_CONCURRENT_REQUESTS,
  PROXY_MAX_REQUESTS,
  PROXY_MAX_SILENCE_MS,
  SOURCE_IDLE_TIMEOUT_MS,
  type SourceDownload,
  type SourceProxy,
} from "./source.js";

const LOCATOR = "https://media.example/videos/source.mp4";
const RULES = [{ origin: "https://media.example" }];
const directories: string[] = [];
const proxies: SourceProxy[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function destination(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "shutter-source-test-"));
  directories.push(directory);

  return join(directory, "source");
}

/** What the origin was asked for. */
interface OriginRequest {
  url: string;
  range: string | null;
  acceptEncoding: string | null;
  signal: AbortSignal;
}

type BodyPlan =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "stall" }
  | { kind: "trickle"; everyMs: number };

/**
 * A response body that behaves like undici's: aborting the request errors it with
 * the abort reason, and cancelling it is observable.
 */
function body(
  plan: BodyPlan,
  signal: AbortSignal,
  cancelled: () => void,
): ReadableStream<Uint8Array> {
  let offset = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        controller.error(signal.reason);
      });
    },
    pull(controller) {
      switch (plan.kind) {
        case "bytes":
          if (offset >= plan.bytes.byteLength) {
            controller.close();

            return;
          }

          controller.enqueue(plan.bytes.subarray(offset, offset + 65_536));
          offset += 65_536;

          return;
        case "stall":
          return new Promise<void>(() => undefined);
        case "trickle":
          return new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              controller.enqueue(new Uint8Array([1]));
              resolve();
            }, plan.everyMs);
          });
        default: {
          const _exhaustive: never = plan;

          return _exhaustive;
        }
      }
    },
    cancel() {
      cancelled();
    },
  });
}

interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: BodyPlan;
  /** How long the origin takes to send its response headers. */
  delayMs?: number;
}

/** Resolves after `ms`, or rejects with the abort reason as the fetch is aborted. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** An RFC 9110 single-range answer over `bytes`. */
function rangeAnswer(bytes: Uint8Array, range: string | null): FakeResponse {
  const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
  if (match === null) {
    return {
      status: 200,
      headers: { "content-length": String(bytes.byteLength) },
      body: { kind: "bytes", bytes },
    };
  }

  const start = Number(match[1]);
  const end = Math.min(
    match[2] === "" ? bytes.byteLength - 1 : Number(match[2]),
    bytes.byteLength - 1,
  );
  if (start >= bytes.byteLength) {
    return { status: 416, headers: { "content-range": `bytes */${bytes.byteLength}` } };
  }

  return {
    status: 206,
    headers: {
      "content-range": `bytes ${start}-${end}/${bytes.byteLength}`,
      "content-length": String(end - start + 1),
      "content-type": "video/mp4",
      "set-cookie": "origin=secret",
    },
    body: { kind: "bytes", bytes: bytes.subarray(start, end + 1) },
  };
}

/** A fake `fetch` for the origin: `answer` decides each response; every request is recorded. */
function origin(answer: (request: OriginRequest, index: number) => FakeResponse) {
  const requests: OriginRequest[] = [];
  let cancelledBodies = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const headers = new Headers(init?.headers);
    const signal = init?.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const request: OriginRequest = {
      url: String(input),
      range: headers.get("range"),
      acceptEncoding: headers.get("accept-encoding"),
      signal,
    };
    requests.push(request);
    const planned = answer(request, requests.length - 1);
    if (planned.delayMs !== undefined) await delay(planned.delayMs, signal);
    const plan = planned.body;
    const stream =
      plan === undefined
        ? null
        : body(plan, signal, () => {
            cancelledBodies += 1;
          });

    return new Response(stream, { status: planned.status, headers: planned.headers ?? {} });
  });

  return {
    fetch,
    requests,
    cancelledBodies: () => cancelledBodies,
  };
}

function download(
  fetch: typeof globalThis.fetch,
  path: string,
  maxBytes = 1024 * 1024,
): SourceDownload {
  return {
    locator: LOCATOR,
    allowedSourceOrigins: RULES,
    fetch,
    maxBytes,
    tooLargeMessage: "too large",
    destination: path,
    signal: new AbortController().signal,
  };
}

async function failure(promise: Promise<unknown>): Promise<ProcessingFailure> {
  const error = await promise.then(
    () => undefined,
    (cause: Error) => cause,
  );
  if (!(error instanceof ProcessingFailure)) throw new Error("expected a ProcessingFailure");

  return error;
}

type ProxyAnswer =
  | { kind: "response"; status: number; headers: IncomingHttpHeaders; body: Buffer }
  | { kind: "reset" };

/** Overrides for one raw request; by default a GET for the proxy's own path. */
interface RawRequest {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}

/** A raw HTTP client, as ffmpeg is: it sends exactly the method, path, and headers given. */
function get(url: string, options: RawRequest = {}): Promise<ProxyAnswer> {
  const target = new URL(url);

  return new Promise((resolve) => {
    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: options.method ?? "GET",
        path: options.path ?? target.pathname,
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", () => resolve({ kind: "reset" }));
        response.on("aborted", () => resolve({ kind: "reset" }));
        response.on("end", () =>
          resolve({
            kind: "response",
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", () => resolve({ kind: "reset" }));
    request.end();
  });
}

/** Starts a read the way ffmpeg does and returns it, to abandon as ffmpeg does when it seeks away. */
function startRead(url: string, range: string): ClientRequest {
  const target = new URL(url);
  const request = httpRequest({
    host: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: { range },
  });
  request.on("error", () => undefined);
  request.end();

  return request;
}

/** Reads the first `bytes` of a range and disconnects; resolves with the status, or 0 for a reset. */
function readThenLeave(url: string, range: string, bytes: number): Promise<number> {
  return new Promise((resolve) => {
    const request = startRead(url, range);
    request.on("error", () => resolve(0));
    request.on("response", (response) => {
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received < bytes) return;

        resolve(response.statusCode ?? 0);
        request.destroy();
      });
      response.on("error", () => resolve(0));
      response.on("aborted", () => resolve(0));
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
  });
}

/** How many bytes a `bytes=start-end` origin request asked for. */
function requestedBytes(range: string | null): number {
  const [, start = "0", end = "-1"] = /^bytes=(\d+)-(\d+)$/.exec(range ?? "") ?? [];

  return Number(end) - Number(start) + 1;
}

/** Opens a proxy over `bytes` through a range-capable fake origin. */
async function proxyOver(
  bytes: Uint8Array,
  answer?: (request: OriginRequest, index: number) => FakeResponse,
) {
  const fake = origin(
    (request, index) => answer?.(request, index) ?? rangeAnswer(bytes, request.range),
  );
  const source = download(fake.fetch, await destination(), 64 * 1024 * 1024);
  const opened = await openRangeSource(source);
  if (opened.kind !== "proxy") throw new Error("expected a proxy");
  proxies.push(opened.proxy);

  return { proxy: opened.proxy, ...fake };
}

describe("downloadSource", () => {
  it("writes the whole source", async () => {
    const bytes = randomBytes(200_000);
    const path = await destination();
    const fake = origin(() => ({ status: 200, body: { kind: "bytes", bytes } }));

    await downloadSource(download(fake.fetch, path));

    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    expect(fake.requests.map(({ url, range }) => ({ url, range }))).toEqual([
      { url: LOCATOR, range: null },
    ]);
  });

  it.each([
    ["a declared length", { "content-length": String(2 * 1024 * 1024) }],
    ["a streamed length", {}],
  ])("rejects a source over the limit by %s as terminal", async (_case, headers) => {
    const fake = origin(() => ({
      status: 200,
      headers,
      body: { kind: "bytes", bytes: randomBytes(2 * 1024 * 1024) },
    }));

    await expect(
      failure(downloadSource(download(fake.fetch, await destination()))),
    ).resolves.toMatchObject({
      code: "source_too_large",
      retryable: false,
    });
  });

  it.each([
    [404, false],
    [410, false],
    [503, true],
  ])("classifies a %i answer (retryable: %s)", async (status, retryable) => {
    const fake = origin(() => ({ status }));

    await expect(
      failure(downloadSource(download(fake.fetch, await destination()))),
    ).resolves.toMatchObject({
      code: "source_missing",
      retryable,
    });
  });

  it("follows an allowlisted redirect", async () => {
    const path = await destination();
    const fake = origin((request) =>
      request.url === LOCATOR
        ? { status: 302, headers: { location: "/videos/moved.mp4" } }
        : { status: 200, body: { kind: "bytes", bytes: new Uint8Array([7, 8]) } },
    );

    await downloadSource(download(fake.fetch, path));

    expect([...(await readFile(path))]).toEqual([7, 8]);
    expect(fake.requests.map(({ url }) => url)).toEqual([
      LOCATOR,
      "https://media.example/videos/moved.mp4",
    ]);
  });

  it.each([
    ["off the allowlist", "https://evil.example/source.mp4"],
    ["downgraded to HTTP", "http://media.example/source.mp4"],
    ["to an unparseable location", "https://["],
  ])("rejects a redirect %s without fetching it", async (_case, location) => {
    const fake = origin(() => ({ status: 302, headers: { location } }));

    await expect(
      failure(downloadSource(download(fake.fetch, await destination()))),
    ).resolves.toMatchObject({
      code: "source_missing",
      retryable: false,
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("rejects a third redirect", async () => {
    const fake = origin((_request, index) => ({
      status: 302,
      headers: { location: `/hop-${index}` },
    }));

    await expect(
      failure(downloadSource(download(fake.fetch, await destination()))),
    ).resolves.toMatchObject({
      code: "source_missing",
      retryable: false,
    });
    expect(fake.requests).toHaveLength(3);
  });

  it("times out an origin that never answers as a retryable failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const pending = failure(downloadSource(download(fetch, await destination())));

    await vi.advanceTimersByTimeAsync(SOURCE_IDLE_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ code: "source_missing", retryable: true });
  });

  it("times out a body that stops arriving, however long the transfer has run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const fake = origin(() => ({ status: 200, body: { kind: "stall" } }));
    const pending = failure(downloadSource(download(fake.fetch, await destination())));

    await vi.advanceTimersByTimeAsync(SOURCE_IDLE_TIMEOUT_MS - 1);
    expect(fake.requests[0]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ code: "source_missing", retryable: true });
    expect(fake.requests[0]?.signal.aborted).toBe(true);
  });

  it("abandons a trickle below the throughput floor", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const fake = origin(() => ({ status: 200, body: { kind: "trickle", everyMs: 20_000 } }));
    const pending = failure(downloadSource(download(fake.fetch, await destination())));

    // Each byte arrives inside the idle window; the second leaves the average far below the floor.
    await vi.advanceTimersByTimeAsync(40_000);

    await expect(pending).resolves.toMatchObject({ code: "source_missing", retryable: true });
  });

  it("rejects with the attempt's own reason when the attempt is abandoned", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    const fake = origin(() => ({ status: 200, body: { kind: "stall" } }));
    const source = download(fake.fetch, await destination());
    source.signal = controller.signal;
    const pending = downloadSource(source);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});

describe("openRangeSource", () => {
  it("probes one byte and serves a range-capable origin through a proxy", async () => {
    const { proxy, requests } = await proxyOver(randomBytes(4096));

    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/);
    expect(
      requests.map(({ url, range, acceptEncoding }) => ({ url, range, acceptEncoding })),
    ).toEqual([{ url: LOCATOR, range: "bytes=0-0", acceptEncoding: "identity" }]);
  });

  it("downloads the probe's answer when the origin ignores Range", async () => {
    const bytes = randomBytes(300_000);
    const path = await destination();
    const fake = origin(() => ({ status: 200, body: { kind: "bytes", bytes } }));

    await expect(openRangeSource(download(fake.fetch, path))).resolves.toEqual({
      kind: "downloaded",
    });
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    expect(fake.requests).toHaveLength(1);
  });

  it.each([
    [
      "an unknown total",
      {
        status: 206,
        headers: { "content-range": "bytes 0-0/*" },
        body: { kind: "bytes", bytes: new Uint8Array([1]) },
      },
    ],
    [
      "a re-encoded body",
      {
        status: 206,
        headers: { "content-range": "bytes 0-0/3", "content-encoding": "gzip" },
        body: { kind: "bytes", bytes: new Uint8Array([1]) },
      },
    ],
    [
      "stacked codings",
      {
        status: 206,
        headers: { "content-range": "bytes 0-0/3", "content-encoding": "identity, gzip" },
        body: { kind: "bytes", bytes: new Uint8Array([1]) },
      },
    ],
    ["an empty source", { status: 416, headers: { "content-range": "bytes */0" } }],
  ] satisfies [string, FakeResponse][])(
    "downloads the whole source after a probe with %s",
    async (_case, probe) => {
      const path = await destination();
      const fake = origin((_request, index) =>
        index === 0
          ? probe
          : { status: 200, body: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) } },
      );

      await expect(openRangeSource(download(fake.fetch, path))).resolves.toEqual({
        kind: "downloaded",
      });
      expect([...(await readFile(path))]).toEqual([1, 2, 3]);
      expect(fake.requests.map(({ range }) => range)).toEqual(["bytes=0-0", null]);
    },
  );

  it.each([
    ["identity", "identity"],
    ["identity in capitals", "IDENTITY"],
  ])("serves a probe answered with %s coding through a proxy", async (_case, encoding) => {
    const bytes = randomBytes(4096);
    const fake = origin((request) => {
      const answer = rangeAnswer(bytes, request.range);

      return { ...answer, headers: { ...answer.headers, "content-encoding": encoding } };
    });

    const opened = await openRangeSource(download(fake.fetch, await destination()));
    if (opened.kind === "proxy") proxies.push(opened.proxy);

    expect(opened.kind).toBe("proxy");
    expect(fake.requests).toHaveLength(1);
  });

  it("takes the size limit from the Content-Range total, as a terminal failure", async () => {
    const fake = origin(() => ({
      status: 206,
      headers: { "content-range": `bytes 0-0/${2 * 1024 * 1024}` },
      body: { kind: "bytes", bytes: new Uint8Array([1]) },
    }));

    await expect(
      failure(openRangeSource(download(fake.fetch, await destination()))),
    ).resolves.toMatchObject({
      code: "source_too_large",
      retryable: false,
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("rejects a probe redirected off the allowlist without fetching it", async () => {
    const fake = origin(() => ({
      status: 307,
      headers: { location: "https://169.254.169.254/latest" },
    }));

    await expect(
      failure(openRangeSource(download(fake.fetch, await destination()))),
    ).resolves.toMatchObject({
      code: "source_missing",
      retryable: false,
    });
    expect(fake.requests).toHaveLength(1);
  });
});

describe("SourceProxy", () => {
  const bytes = randomBytes(256 * 1024);

  it("forwards a range with the exact bytes and none of the origin's headers", async () => {
    const { proxy, requests } = await proxyOver(bytes);

    const answer = await get(proxy.url, { headers: { range: "bytes=10-19" } });

    expect(answer).toMatchObject({
      kind: "response",
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "content-range": `bytes 10-19/${bytes.byteLength}`,
        "content-length": "10",
      },
    });
    if (answer.kind !== "response") return;
    expect(Buffer.compare(answer.body, bytes.subarray(10, 20))).toBe(0);
    expect(answer.headers["set-cookie"]).toBeUndefined();
    expect(requests.map(({ range, acceptEncoding }) => ({ range, acceptEncoding }))).toEqual([
      { range: "bytes=0-0", acceptEncoding: "identity" },
      { range: "bytes=10-19", acceptEncoding: "identity" },
    ]);
  });

  it("serves the open-ended range and the plain request ffmpeg can send", async () => {
    const { proxy } = await proxyOver(bytes);

    const tail = await get(proxy.url, { headers: { range: `bytes=${bytes.byteLength - 5}-` } });
    const whole = await get(proxy.url);

    expect(tail).toMatchObject({ kind: "response", status: 206, body: bytes.subarray(-5) });
    expect(whole).toMatchObject({ kind: "response", status: 200 });
    if (whole.kind === "response") expect(Buffer.compare(whole.body, bytes)).toBe(0);
  });

  it.each([
    ["a different path", (): RawRequest => ({ path: "/not-the-token" })],
    ["the token with a suffix", (url: URL): RawRequest => ({ path: `${url.pathname}.m3u8` })],
    ["another Host", (): RawRequest => ({ headers: { host: "media.example" } })],
  ])("answers %s with 404 without contacting the origin", async (_case, request) => {
    const { proxy, requests } = await proxyOver(bytes);

    await expect(get(proxy.url, request(new URL(proxy.url)))).resolves.toMatchObject({
      kind: "response",
      status: 404,
    });
    expect(requests).toHaveLength(1);
  });

  it("answers anything but GET with 405", async () => {
    const { proxy, requests } = await proxyOver(bytes);

    await expect(get(proxy.url, { method: "POST" })).resolves.toMatchObject({
      kind: "response",
      status: 405,
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["past the end", `bytes=${256 * 1024}-`],
    ["a suffix range", "bytes=-100"],
    ["several ranges", "bytes=0-1,5-6"],
    ["an inverted range", "bytes=9-3"],
  ])("refuses %s with 416 without contacting the origin", async (_case, range) => {
    const { proxy, requests } = await proxyOver(bytes);

    await expect(get(proxy.url, { headers: { range } })).resolves.toMatchObject({
      kind: "response",
      status: 416,
      headers: { "content-range": `bytes */${bytes.byteLength}` },
    });
    expect(requests).toHaveLength(1);
  });

  it("re-checks the allowlist when a forwarded range is redirected, and fails the job terminally", async () => {
    const { proxy, requests } = await proxyOver(bytes, (request, index) =>
      index === 0
        ? rangeAnswer(bytes, request.range)
        : { status: 302, headers: { location: "http://127.0.0.1:9/internal" } },
    );

    await expect(get(proxy.url, { headers: { range: "bytes=0-" } })).resolves.toEqual({
      kind: "reset",
    });
    expect(proxy.outcome).toMatchObject({
      kind: "failed",
      failure: { code: "source_missing", retryable: false },
    });
    expect(requests.map(({ url }) => url)).toEqual([LOCATOR, LOCATOR]);
    await expect(get(proxy.url, { headers: { range: "bytes=0-" } })).resolves.toMatchObject({
      status: 503,
    });
  });

  it("follows an allowlisted redirect on a forwarded range", async () => {
    const { proxy } = await proxyOver(bytes, (request, index) =>
      index === 1
        ? { status: 302, headers: { location: "/videos/mirror.mp4" } }
        : rangeAnswer(bytes, request.range),
    );

    await expect(get(proxy.url, { headers: { range: "bytes=0-3" } })).resolves.toMatchObject({
      status: 206,
      body: bytes.subarray(0, 4),
    });
    expect(proxy.outcome).toBeUndefined();
  });

  it.each([
    ["a 404", 404, false],
    ["a 410", 410, false],
    ["a 503", 503, true],
  ])(
    "records %s from the origin as source_missing (retryable: %s)",
    async (_case, status, retryable) => {
      const { proxy } = await proxyOver(bytes, (request, index) =>
        index === 0 ? rangeAnswer(bytes, request.range) : { status },
      );

      await expect(get(proxy.url, { headers: { range: "bytes=0-" } })).resolves.toEqual({
        kind: "reset",
      });
      expect(proxy.outcome).toMatchObject({
        kind: "failed",
        failure: { code: "source_missing", retryable },
      });
    },
  );

  it.each([
    [
      "answers a range with 200",
      (): FakeResponse => ({ status: 200, body: { kind: "bytes", bytes } }),
    ],
    [
      "answers a different span",
      (): FakeResponse => ({
        status: 206,
        headers: { "content-range": `bytes 1-4/${bytes.byteLength}` },
        body: { kind: "bytes", bytes: bytes.subarray(1, 5) },
      }),
    ],
    [
      "reports a different total",
      (): FakeResponse => ({
        status: 206,
        headers: { "content-range": "bytes 0-3/999999999" },
        body: { kind: "bytes", bytes: bytes.subarray(0, 4) },
      }),
    ],
    [
      "re-encodes the body",
      (): FakeResponse => ({
        status: 206,
        headers: { "content-range": `bytes 0-3/${bytes.byteLength}`, "content-encoding": "br" },
        body: { kind: "bytes", bytes: bytes.subarray(0, 4) },
      }),
    ],
  ])("falls back to a download when the origin %s", async (_case, answer) => {
    const { proxy } = await proxyOver(bytes, (request, index) =>
      index === 0 ? rangeAnswer(bytes, request.range) : answer(),
    );

    await expect(get(proxy.url, { headers: { range: "bytes=0-3" } })).resolves.toEqual({
      kind: "reset",
    });
    expect(proxy.outcome).toEqual({ kind: "fallback" });
  });

  it("pulls a long read from the origin in windows that double up to the cap", async () => {
    const source = randomBytes(12 * 1024 * 1024);
    const { proxy, requests } = await proxyOver(source);

    const answer = await get(proxy.url, { headers: { range: "bytes=0-" } });

    expect(answer).toMatchObject({
      kind: "response",
      status: 206,
      headers: { "content-range": `bytes 0-12582911/${source.byteLength}` },
    });
    if (answer.kind === "response") expect(Buffer.compare(answer.body, source)).toBe(0);
    expect(requests.map(({ range }) => range)).toEqual([
      "bytes=0-0",
      "bytes=0-262143",
      "bytes=262144-786431",
      "bytes=786432-1835007",
      "bytes=1835008-3932159",
      "bytes=3932160-8126463",
      "bytes=8126464-12320767",
      "bytes=12320768-12582911",
    ]);
    expect(proxy.outcome).toBeUndefined();
  });

  it("requests no further window once ffmpeg disconnects", async () => {
    const source = randomBytes(12 * 1024 * 1024);
    const { proxy, requests } = await proxyOver(source, (request, index) =>
      index === 2
        ? {
            status: 206,
            headers: { "content-range": `bytes 262144-786431/${source.byteLength}` },
            body: { kind: "stall" },
          }
        : rangeAnswer(source, request.range),
    );
    const read = startRead(proxy.url, "bytes=0-");
    await vi.waitFor(() => expect(requests).toHaveLength(3));

    read.destroy();

    await vi.waitFor(() => expect(requests[2]?.signal.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests.map(({ range }) => range)).toEqual([
      "bytes=0-0",
      "bytes=0-262143",
      "bytes=262144-786431",
    ]);
    expect(proxy.outcome).toBeUndefined();
  });

  it("charges each window before asking for it, so reads ffmpeg abandons cannot pull more than the budget", async () => {
    const source = randomBytes(4 * 1024 * 1024);
    const { proxy, requests } = await proxyOver(source);

    // Open-ended reads, each abandoned after 32 KiB, until the proxy stops answering them.
    let status = 206;
    while (status === 206) status = await readThenLeave(proxy.url, "bytes=0-", 32 * 1024);

    expect(proxy.outcome).toEqual({ kind: "fallback" });
    const asked = requests.slice(1).reduce((total, { range }) => total + requestedBytes(range), 0);
    expect(asked).toBeLessThanOrEqual(source.byteLength + PROXY_BUDGET_SLACK_BYTES);
  });

  it("falls back once it has asked for a copy of the source plus the slack", async () => {
    const source = randomBytes(4 * 1024 * 1024);
    const { proxy } = await proxyOver(source);
    // The budget is spent exactly by the last full read; the next one overruns it.
    const reads = (source.byteLength + PROXY_BUDGET_SLACK_BYTES) / source.byteLength + 1;

    for (let read = 0; read < reads; read += 1) {
      const answer = await get(proxy.url, { headers: { range: "bytes=0-" } });
      if (read < reads - 1) expect(answer).toMatchObject({ status: 206 });
      else expect(answer).toEqual({ kind: "reset" });
    }

    expect(proxy.outcome).toEqual({ kind: "fallback" });
  });

  it("falls back after its request budget", async () => {
    const { proxy } = await proxyOver(bytes);

    for (let read = 0; read < PROXY_MAX_REQUESTS; read += 1) {
      await expect(get(proxy.url, { headers: { range: "bytes=0-0" } })).resolves.toMatchObject({
        status: 206,
      });
    }

    await expect(get(proxy.url, { headers: { range: "bytes=0-0" } })).resolves.toEqual({
      kind: "reset",
    });
    expect(proxy.outcome).toEqual({ kind: "fallback" });
    await expect(get(proxy.url, { headers: { range: "bytes=0-0" } })).resolves.toMatchObject({
      status: 503,
    });
  });

  it("counts each redirect hop against the request budget", async () => {
    const { proxy } = await proxyOver(bytes, (request, index) =>
      index > 0 && request.url === LOCATOR
        ? { status: 302, headers: { location: "/videos/mirror.mp4" } }
        : rangeAnswer(bytes, request.range),
    );

    for (let read = 0; read < PROXY_MAX_REQUESTS / 2; read += 1) {
      await expect(get(proxy.url, { headers: { range: "bytes=0-0" } })).resolves.toMatchObject({
        status: 206,
      });
    }

    await expect(get(proxy.url, { headers: { range: "bytes=0-0" } })).resolves.toEqual({
      kind: "reset",
    });
    expect(proxy.outcome).toEqual({ kind: "fallback" });
  });

  it("falls back when ffmpeg opens more than four reads at once", async () => {
    const { proxy, requests } = await proxyOver(bytes, (request, index) =>
      index === 0
        ? rangeAnswer(bytes, request.range)
        : {
            status: 206,
            headers: { "content-range": `bytes 0-9/${bytes.byteLength}` },
            body: { kind: "stall" },
          },
    );
    const stalled = Array.from({ length: PROXY_MAX_CONCURRENT_REQUESTS }, () =>
      get(proxy.url, { headers: { range: "bytes=0-9" } }),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1 + PROXY_MAX_CONCURRENT_REQUESTS));

    await expect(get(proxy.url, { headers: { range: "bytes=0-9" } })).resolves.toMatchObject({
      status: 503,
    });
    expect(proxy.outcome).toEqual({ kind: "fallback" });
    // Settling aborts the reads already open.
    await expect(Promise.all(stalled)).resolves.toEqual(stalled.map(() => ({ kind: "reset" })));
  });

  it("fails a stalled range as a retryable timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { proxy, requests } = await proxyOver(bytes, (request, index) =>
      index === 0
        ? rangeAnswer(bytes, request.range)
        : {
            status: 206,
            headers: { "content-range": `bytes 0-9/${bytes.byteLength}` },
            body: { kind: "stall" },
          },
    );
    const pending = get(proxy.url, { headers: { range: "bytes=0-9" } });
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    await vi.advanceTimersByTimeAsync(SOURCE_IDLE_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ kind: "reset" });
    expect(proxy.outcome).toMatchObject({
      kind: "failed",
      failure: { code: "source_missing", retryable: true },
    });
  });

  it("reports an origin that keeps a read waiting through slow redirects as a retryable timeout, before ffmpeg would give up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    // Each forwarded window is redirected after 20 s and answered correctly after 20 s more.
    const { proxy, requests } = await proxyOver(bytes, (request, index) => {
      if (index === 0) return rangeAnswer(bytes, request.range);
      if (request.url === LOCATOR) {
        return { status: 302, headers: { location: "/videos/signed.mp4" }, delayMs: 20_000 };
      }

      return { ...rangeAnswer(bytes, request.range), delayMs: 20_000 };
    });
    const pending = get(proxy.url, { headers: { range: "bytes=0-" } });
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    // ffmpeg waits longer than PROXY_MAX_SILENCE_MS for a byte; the proxy has settled well within it.
    await vi.advanceTimersByTimeAsync(PROXY_MAX_SILENCE_MS / 2);

    await expect(pending).resolves.toEqual({ kind: "reset" });
    expect(requests.map(({ url }) => url)).toEqual([
      LOCATOR,
      LOCATOR,
      "https://media.example/videos/signed.mp4",
    ]);
    expect(proxy.outcome).toMatchObject({
      kind: "failed",
      failure: { code: "source_missing", retryable: true },
    });
  });

  it("falls back when ffmpeg gives up on a read the origin has not answered", async () => {
    const { proxy, requests } = await proxyOver(bytes, (request, index) =>
      index === 0
        ? rangeAnswer(bytes, request.range)
        : { ...rangeAnswer(bytes, request.range), delayMs: 600_000 },
    );
    const read = startRead(proxy.url, "bytes=0-");
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    read.destroy();

    await vi.waitFor(() => expect(requests[1]?.signal.aborted).toBe(true));
    expect(proxy.outcome).toEqual({ kind: "fallback" });
  });

  it("stops the origin transfer when ffmpeg disconnects, without recording a failure", async () => {
    const { proxy, requests } = await proxyOver(bytes, (request, index) =>
      index === 0
        ? rangeAnswer(bytes, request.range)
        : {
            status: 206,
            headers: { "content-range": `bytes 0-9/${bytes.byteLength}` },
            body: { kind: "stall" },
          },
    );
    const target = new URL(proxy.url);
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { range: "bytes=0-9" },
    });
    request.on("error", () => undefined);
    request.end();
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    request.destroy();

    await vi.waitFor(() => expect(requests[1]?.signal.aborted).toBe(true));
    expect(proxy.outcome).toBeUndefined();
  });

  it("aborts origin requests when the attempt is abandoned", async () => {
    const controller = new AbortController();
    const fake = origin((request, index) =>
      index === 0
        ? rangeAnswer(bytes, request.range)
        : {
            status: 206,
            headers: { "content-range": `bytes 0-9/${bytes.byteLength}` },
            body: { kind: "stall" },
          },
    );
    const source = download(fake.fetch, await destination());
    source.signal = controller.signal;
    const opened = await openRangeSource(source);
    if (opened.kind !== "proxy") throw new Error("expected a proxy");
    proxies.push(opened.proxy);
    const pending = get(opened.proxy.url, { headers: { range: "bytes=0-9" } });
    await vi.waitFor(() => expect(fake.requests).toHaveLength(2));

    controller.abort(new Error("lease lost"));

    await vi.waitFor(() => expect(fake.requests[1]?.signal.aborted).toBe(true));
    await opened.proxy.close();
    await expect(pending).resolves.toEqual({ kind: "reset" });
    expect(opened.proxy.outcome).toBeUndefined();
  });

  it("stops listening when closed", async () => {
    const { proxy } = await proxyOver(bytes);

    await proxy.close();

    await expect(get(proxy.url, { headers: { range: "bytes=0-0" } })).resolves.toEqual({
      kind: "reset",
    });
  });
});
