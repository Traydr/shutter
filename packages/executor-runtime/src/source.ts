import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { pipeline } from "node:stream/promises";
import { type SourceOriginRule, validateSourceLocator } from "@shutter/protocol";
import { z } from "zod";
import { ProcessingFailure } from "./media.js";

/** A Preview Job source and the limits on reading it. */
export interface SourceRequest {
  locator: string;
  allowedSourceOrigins: readonly SourceOriginRule[];
  fetch: typeof globalThis.fetch;
  maxBytes: number;
  tooLargeMessage: string;
  /** Abandons the attempt: cancels every source request and stops the proxy serving. */
  signal: AbortSignal;
}

export interface SourceDownload extends SourceRequest {
  /** The file the whole source is written to. */
  destination: string;
}

/** Longest an origin may keep a request waiting for response headers or for the next body bytes. */
export const SOURCE_IDLE_TIMEOUT_MS = 30_000;
/**
 * The slowest average transfer a source read may sustain once SOURCE_IDLE_TIMEOUT_MS
 * of waiting is spent, so a 512 MiB video may take 30 s + 512 s. Only time spent
 * waiting on the origin counts; a consumer applying backpressure never trips it.
 */
export const SOURCE_MIN_BYTES_PER_SECOND = 1024 * 1024;
export const SOURCE_MAX_REDIRECTS = 2;

/** Most reads the proxy serves at once; ffmpeg needs one, two while it seeks. */
export const PROXY_MAX_CONCURRENT_REQUESTS = 4;
/**
 * Most requests one job's proxy makes of the origin, each window and redirect
 * hop counted, before a local copy becomes the cheaper route.
 */
export const PROXY_MAX_REQUESTS = 256;
/** What the proxy may ask of the origin beyond one copy of the source: the windows seeks abandon. */
export const PROXY_BUDGET_SLACK_BYTES = 16 * 1024 * 1024;
/** The first window of every read the proxy forwards; a demuxer's header and seek reads mostly fit. */
export const PROXY_FIRST_WINDOW_BYTES = 256 * 1024;
/** Each further window of a read doubles, up to this. */
export const PROXY_MAX_WINDOW_BYTES = 4 * 1024 * 1024;
/**
 * Longest the proxy can leave a reader without a byte while it waits on the
 * origin: a window's request and each of its redirect hops, then its first body
 * bytes, each up to SOURCE_IDLE_TIMEOUT_MS. By then the proxy has settled the
 * problem itself, so a reader's own timeout must be longer.
 */
export const PROXY_MAX_SILENCE_MS = (SOURCE_MAX_REDIRECTS + 2) * SOURCE_IDLE_TIMEOUT_MS;

function temporaryFailure(): ProcessingFailure {
  return new ProcessingFailure("source_missing", "temporary source failure", true);
}

function unavailable(status: number): ProcessingFailure {
  return status === 404 || status === 410
    ? new ProcessingFailure("source_missing", "source missing")
    : temporaryFailure();
}

function allowlistedUrl(locator: string, rules: readonly SourceOriginRule[]): URL {
  try {
    validateSourceLocator(locator, rules);

    return new URL(locator);
  } catch {
    throw new ProcessingFailure("source_missing", "source locator is not allowlisted");
  }
}

/**
 * Bounds one source read: a download, or one read the proxy forwards, across all
 * its windows. Waiting SOURCE_IDLE_TIMEOUT_MS for headers or body bytes, or
 * falling below the throughput floor, aborts it as a retryable timeout; the
 * attempt's own signal aborts it with the attempt's reason.
 */
class SourceDeadline {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  #idle: ReturnType<typeof setTimeout> | undefined;
  #waitStartedAt = 0;
  #waitedMs = 0;
  #bytes = 0;
  #expiry: ProcessingFailure | undefined;

  constructor(signals: readonly AbortSignal[]) {
    this.signal = AbortSignal.any([this.#controller.signal, ...signals]);
  }

  /** Set once the origin was too slow; what any resulting abort error stands for. */
  get expiry(): ProcessingFailure | undefined {
    return this.#expiry;
  }

  waiting(): void {
    this.#waitStartedAt = performance.now();
    this.#idle = setTimeout(() => this.#expire(), SOURCE_IDLE_TIMEOUT_MS);
  }

  received(bytes: number): void {
    clearTimeout(this.#idle);
    this.#waitedMs += performance.now() - this.#waitStartedAt;
    this.#bytes += bytes;
    const allowedMs = SOURCE_IDLE_TIMEOUT_MS + (this.#bytes / SOURCE_MIN_BYTES_PER_SECOND) * 1_000;
    if (this.#waitedMs > allowedMs) throw this.#expire();
  }

  /** Stops the request without a failure: whoever wanted the bytes has gone. */
  cancel(): void {
    clearTimeout(this.#idle);
    this.#controller.abort();
  }

  finish(): void {
    clearTimeout(this.#idle);
  }

  #expire(): ProcessingFailure {
    const expiry = new ProcessingFailure("source_missing", "source request timed out", true);
    this.#expiry ??= expiry;
    this.#controller.abort(expiry);

    return expiry;
  }
}

interface FetchedSource {
  response: Response;
  /** The URL that answered, after allowlisted redirects. */
  url: URL;
}

interface ByteSpan {
  start: number;
  end: number;
}

/** One source request: where it goes, the deadline it runs under, and what it asks for. */
interface SourceFetch {
  url: URL;
  deadline: SourceDeadline;
  /** Asks for these bytes, in the stored encoding: offsets mean nothing in any other. */
  range?: ByteSpan;
  /** Runs before every request, redirect hops included, and throws to stop it being sent. */
  beforeRequest?: () => void;
}

/** Fetches a source, following at most SOURCE_MAX_REDIRECTS redirects and re-checking the allowlist on every hop. */
async function fetchSource(
  request: SourceRequest,
  { url, deadline, range, beforeRequest }: SourceFetch,
): Promise<FetchedSource> {
  let current = url;
  for (let redirects = 0; ; redirects += 1) {
    const init: RequestInit = { redirect: "manual", signal: deadline.signal };
    if (range !== undefined) {
      init.headers = { range: `bytes=${range.start}-${range.end}`, "accept-encoding": "identity" };
    }

    beforeRequest?.();
    deadline.waiting();
    let response: Response;
    try {
      response = await request.fetch(current, init);
    } catch (error) {
      throw deadline.expiry ?? error;
    }

    deadline.received(0);
    if (response.status < 300 || response.status >= 400) return { response, url: current };

    await response.body?.cancel();
    const location = response.headers.get("location");
    if (location === null || redirects === SOURCE_MAX_REDIRECTS) {
      throw new ProcessingFailure("source_missing", "redirect rejected");
    }

    const next = URL.parse(location, current);
    if (next === null) throw new ProcessingFailure("source_missing", "redirect rejected");
    current = allowlistedUrl(next.href, request.allowedSourceOrigins);
  }
}

/** Yields a response body's chunks under the deadline and the byte limit. */
async function* readSource(
  body: ReadableStream<Uint8Array>,
  deadline: SourceDeadline,
  request: SourceRequest,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      deadline.waiting();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw deadline.expiry ?? error;
      }

      deadline.received(chunk.done ? 0 : chunk.value.byteLength);
      if (chunk.done) return;

      bytes += chunk.value.byteLength;
      if (bytes > request.maxBytes) {
        throw new ProcessingFailure("source_too_large", request.tooLargeMessage);
      }

      yield chunk.value;
    }
  } finally {
    // Stops this body's transfer when its consumer stops early or the limit is hit, leaving
    // the deadline to whatever reads next; a no-op once the body ended or failed.
    await reader.cancel().catch(() => undefined);
  }
}

async function saveSource(
  response: Response,
  download: SourceDownload,
  deadline: SourceDeadline,
): Promise<void> {
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw unavailable(response.status);
  }

  if (Number(response.headers.get("content-length")) > download.maxBytes) {
    await response.body.cancel();
    throw new ProcessingFailure("source_too_large", download.tooLargeMessage);
  }

  await pipeline(
    readSource(response.body, deadline, download),
    createWriteStream(download.destination),
  );
}

/** Downloads a whole source to `destination`. */
export async function downloadSource(download: SourceDownload): Promise<void> {
  const url = allowlistedUrl(download.locator, download.allowedSourceOrigins);
  const deadline = new SourceDeadline([download.signal]);
  try {
    const { response } = await fetchSource(download, { url, deadline });
    await saveSource(response, download, deadline);
  } finally {
    deadline.finish();
  }
}

interface ContentRange extends ByteSpan {
  total: number;
}

/** Parses `Content-Range: bytes start-end/total`; an unknown total or any other form is unusable. */
function parseContentRange(header: string | null): ContentRange | undefined {
  const match = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(header ?? "");
  if (match === null) return undefined;

  const [, start = "", end = "", total = ""] = match;
  const range = { start: Number(start), end: Number(end), total: Number(total) };

  return range.start <= range.end && range.end < range.total ? range : undefined;
}

/** Whether a body is in anything but its stored bytes: only an absent or lone `identity` coding is not. */
function encoded(response: Response): boolean {
  const encoding = response.headers.get("content-encoding");

  return encoding !== null && encoding.trim().toLowerCase() !== "identity";
}

/**
 * Opens a source for ffmpeg. One `Range: bytes=0-0` probe learns the size from
 * `Content-Range`, so the size limit stays terminal; an origin that honors ranges
 * is then served through a loopback SourceProxy. An origin that ignores Range
 * answers the probe with the whole body, which is downloaded to `destination`.
 */
export async function openRangeSource(download: SourceDownload): Promise<RangeSource> {
  const url = allowlistedUrl(download.locator, download.allowedSourceOrigins);
  const deadline = new SourceDeadline([download.signal]);
  let probe: FetchedSource;
  try {
    probe = await fetchSource(download, { url, deadline, range: { start: 0, end: 0 } });
    if (probe.response.status !== 206 && probe.response.status !== 416) {
      await saveSource(probe.response, download, deadline);

      return { kind: "downloaded" };
    }
  } finally {
    deadline.finish();
  }

  await probe.response.body?.cancel();
  const span = parseContentRange(probe.response.headers.get("content-range"));
  if (probe.response.status === 416 || span === undefined || encoded(probe.response)) {
    // An empty source, an unknown total, or a re-encoded body: offsets are unusable, so read it whole.
    await downloadSource(download);

    return { kind: "downloaded" };
  }

  if (span.total > download.maxBytes) {
    throw new ProcessingFailure("source_too_large", download.tooLargeMessage);
  }

  return { kind: "proxy", proxy: await SourceProxy.listen(download, probe.url, span.total) };
}

export type RangeSource = { kind: "proxy"; proxy: SourceProxy } | { kind: "downloaded" };

/**
 * Why the proxy stopped serving. `failed` is final for the attempt; `fallback`
 * means the proxy can no longer vouch for what ffmpeg read (the origin stopped
 * honoring ranges, a budget ran out, or ffmpeg gave up on a read), and a full
 * download should replace it.
 */
export type ProxyOutcome = { kind: "failed"; failure: ProcessingFailure } | { kind: "fallback" };

type RequestedRange =
  | { kind: "whole"; span: ByteSpan }
  | { kind: "partial"; span: ByteSpan }
  | { kind: "unsatisfiable" };

type ServedRange = Exclude<RequestedRange, { kind: "unsatisfiable" }>;

/** Accepts no header or one `bytes=start-[end]` range, the forms ffmpeg sends. */
function parseRequestedRange(header: string | undefined, size: number): RequestedRange {
  if (header === undefined) return { kind: "whole", span: { start: 0, end: size - 1 } };

  const match = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(header);
  if (match === null) return { kind: "unsatisfiable" };

  const [, first = "", last = ""] = match;
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);

  return start <= end ? { kind: "partial", span: { start, end } } : { kind: "unsatisfiable" };
}

/** The first window of a read: PROXY_FIRST_WINDOW_BYTES, or the whole read when it is shorter. */
function firstWindow(span: ByteSpan): ByteSpan {
  return { start: span.start, end: Math.min(span.end, span.start + PROXY_FIRST_WINDOW_BYTES - 1) };
}

/** The window after `previous`, twice its length up to PROXY_MAX_WINDOW_BYTES; none once the read is covered. */
function nextWindow(span: ByteSpan, previous: ByteSpan): ByteSpan | undefined {
  if (previous.end === span.end) return undefined;

  const length = Math.min(2 * spanLength(previous), PROXY_MAX_WINDOW_BYTES);

  return { start: previous.end + 1, end: Math.min(span.end, previous.end + length) };
}

function spanLength(span: ByteSpan): number {
  return span.end - span.start + 1;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function drained(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.on("drain", done);
    response.on("close", done);
  });
}

const listeningAddressSchema = z.object({ port: z.int().positive() });

/**
 * Serves one source to ffmpeg over loopback HTTP so it fetches only the byte
 * ranges it reads. ffmpeg never sees the origin: the proxy forwards each Range
 * request itself, in windows, so every redirect hop is allowlisted in Node, and
 * it answers only GETs for its random path on 127.0.0.1. Each window is charged
 * before it is requested, so the origin is asked for at most one copy of the
 * source plus PROXY_BUDGET_SLACK_BYTES, in at most PROXY_MAX_REQUESTS requests.
 * The proxy stops at the first problem, recording it in `outcome` for the
 * caller to act on.
 */
export class SourceProxy {
  /** The loopback URL ffmpeg reads; it has no file extension to steer demuxer probing. */
  readonly url: string;
  readonly #server: Server;
  readonly #request: SourceRequest;
  readonly #origin: URL;
  readonly #size: number;
  readonly #host: string;
  readonly #path: Buffer;
  readonly #budget: number;
  readonly #controller = new AbortController();
  /** Bytes asked of the origin, each window counted in full before it is requested. */
  #charged = 0;
  /** Requests made of the origin, redirect hops included. */
  #requests = 0;
  #active = 0;
  /** Called once no read is in progress. */
  readonly #idleWaiters: (() => void)[] = [];
  #outcome: ProxyOutcome | undefined;
  #closed = false;

  private constructor(server: Server, port: number, target: ProxyTarget) {
    const token = randomBytes(32).toString("base64url");
    this.#server = server;
    this.#request = target.request;
    this.#origin = target.origin;
    this.#size = target.size;
    this.#host = `127.0.0.1:${port}`;
    this.#path = sha256(`/${token}`);
    this.#budget = target.size + PROXY_BUDGET_SLACK_BYTES;
    this.url = `http://${this.#host}/${token}`;
    server.on("request", (request, response) => this.#handle(request, response));
  }

  /** Starts a proxy for `origin`, an allowlisted URL whose representation is `size` bytes. */
  static async listen(request: SourceRequest, origin: URL, size: number): Promise<SourceProxy> {
    const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000 });
    server.maxHeadersCount = 32;
    server.maxConnections = 4 * PROXY_MAX_CONCURRENT_REQUESTS;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = listeningAddressSchema.safeParse(server.address());
    if (!address.success) {
      server.close();
      throw new Error("source proxy did not bind a TCP port");
    }

    return new SourceProxy(server, address.data.port, { request, origin, size });
  }

  get outcome(): ProxyOutcome | undefined {
    return this.#outcome;
  }

  /**
   * Resolves once no read is in progress. After ffmpeg exits, that is once the
   * proxy has seen it leave every read, so `outcome` covers all of them.
   */
  idle(): Promise<void> {
    if (this.#active === 0) return Promise.resolve();

    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Stops serving: aborts upstream requests and drops ffmpeg's connections. */
  async close(): Promise<void> {
    if (this.#closed) return;

    this.#closed = true;
    this.#controller.abort();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** Records the first problem and aborts every upstream request; later ones change nothing. */
  #settle(outcome: ProxyOutcome): void {
    if (this.#outcome !== undefined) return;

    this.#outcome = outcome;
    this.#controller.abort();
  }

  /** The proxy was closed or the attempt abandoned: what fails from now on says nothing about the source. */
  #stopped(): boolean {
    return this.#closed || this.#request.signal.aborted;
  }

  #authorized(request: IncomingMessage): boolean {
    return (
      request.headers.host === this.#host && timingSafeEqual(sha256(request.url ?? ""), this.#path)
    );
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    if (!this.#authorized(request)) {
      response.writeHead(404).end();

      return;
    }

    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" }).end();

      return;
    }

    if (this.#closed || this.#outcome !== undefined) {
      response.writeHead(503).end();

      return;
    }

    // More reads at once than a seeking ffmpeg opens: it is not reading the way the proxy assumes.
    if (this.#active >= PROXY_MAX_CONCURRENT_REQUESTS) {
      this.#settle({ kind: "fallback" });
      response.writeHead(503).end();

      return;
    }

    const range = parseRequestedRange(request.headers.range, this.#size);
    if (range.kind === "unsatisfiable") {
      response.writeHead(416, { "content-range": `bytes */${this.#size}` }).end();

      return;
    }

    this.#active += 1;
    void this.#forward(range, response).finally(() => {
      this.#active -= 1;
      if (this.#active === 0) for (const resolve of this.#idleWaiters.splice(0)) resolve();
    });
  }

  /** Checks an upstream answer to a window; anything but the exact span stops the proxy. */
  #verdict(upstream: Response, window: ByteSpan): ProxyOutcome | undefined {
    if (upstream.status === 206) {
      const answered = parseContentRange(upstream.headers.get("content-range"));
      const exact =
        answered !== undefined &&
        answered.start === window.start &&
        answered.end === window.end &&
        answered.total === this.#size &&
        !encoded(upstream);

      return exact ? undefined : { kind: "fallback" };
    }

    if (upstream.status === 200 || upstream.status === 416) return { kind: "fallback" };

    return { kind: "failed", failure: unavailable(upstream.status) };
  }

  /** Counts one origin request; past PROXY_MAX_REQUESTS, or once the proxy has settled, it is not sent. */
  #countRequest(): void {
    this.#requests += 1;
    if (this.#requests > PROXY_MAX_REQUESTS) this.#settle({ kind: "fallback" });
    this.#controller.signal.throwIfAborted();
  }

  /**
   * Requests one window, charging its full length to the byte budget first, and
   * returns its body once the origin answered with exactly that span. Any other
   * answer settles the proxy and throws.
   */
  async #fetchWindow(
    window: ByteSpan,
    deadline: SourceDeadline,
  ): Promise<ReadableStream<Uint8Array>> {
    this.#charged += spanLength(window);
    if (this.#charged > this.#budget) this.#settle({ kind: "fallback" });
    this.#controller.signal.throwIfAborted();

    const { response: upstream } = await fetchSource(this.#request, {
      url: this.#origin,
      deadline,
      range: window,
      beforeRequest: () => this.#countRequest(),
    });
    const rejected = this.#verdict(upstream, window);
    if (rejected === undefined && upstream.body !== null) return upstream.body;

    // Settling aborts every upstream request, this body included, and the read stops here.
    this.#settle(rejected ?? temporaryFailureOutcome());
    throw this.#controller.signal.reason;
  }

  #answer(range: ServedRange, response: ServerResponse): void {
    const { span } = range;
    const headers: OutgoingHttpHeaders = {
      "content-type": "application/octet-stream",
      "content-length": spanLength(span),
      "accept-ranges": "bytes",
    };
    if (range.kind === "partial") {
      headers["content-range"] = `bytes ${span.start}-${span.end}/${this.#size}`;
    }

    response.writeHead(range.kind === "partial" ? 206 : 200, headers);
  }

  /**
   * Answers one ffmpeg read as a single response, pulling it from the origin in
   * windows: PROXY_FIRST_WINDOW_BYTES first, then each twice the last, up to
   * PROXY_MAX_WINDOW_BYTES. A short read costs one small request and a long one
   * few; the next window is requested only once ffmpeg has taken the last and is
   * still connected.
   */
  async #forward(range: ServedRange, response: ServerResponse): Promise<void> {
    const deadline = new SourceDeadline([this.#controller.signal, this.#request.signal]);
    let answered = false;
    let clientGone = false;
    const onClose = () => {
      if (response.writableFinished) return;

      clientGone = true;
      deadline.cancel();
      // ffmpeg reads one request at a time and abandons one still unanswered only when its own
      // read timeout fires, so whatever it decodes next cannot be trusted.
      if (!answered && !this.#stopped()) this.#settle({ kind: "fallback" });
    };
    response.once("close", onClose);
    try {
      for (
        let window: ByteSpan | undefined = firstWindow(range.span);
        window !== undefined;
        window = nextWindow(range.span, window)
      ) {
        if (clientGone) return;

        const body = await this.#fetchWindow(window, deadline);
        if (!answered) {
          this.#answer(range, response);
          answered = true;
        }

        let sent = 0;
        for await (const chunk of readSource(body, deadline, this.#request)) {
          sent += chunk.byteLength;
          if (sent > spanLength(window)) {
            this.#settle({ kind: "fallback" });
            response.destroy();

            return;
          }

          if (!response.write(chunk)) await drained(response);
          if (clientGone) return;
        }

        if (sent !== spanLength(window)) throw temporaryFailure();
      }

      response.end();
    } catch (error) {
      // A settled proxy keeps its first problem; ffmpeg leaving was handled when it left.
      if (!clientGone && !this.#stopped()) {
        this.#settle({
          kind: "failed",
          failure:
            deadline.expiry ?? (error instanceof ProcessingFailure ? error : temporaryFailure()),
        });
      }

      response.destroy();
    } finally {
      response.off("close", onClose);
      deadline.finish();
    }
  }
}

interface ProxyTarget {
  request: SourceRequest;
  origin: URL;
  size: number;
}

function temporaryFailureOutcome(): ProxyOutcome {
  return { kind: "failed", failure: temporaryFailure() };
}
