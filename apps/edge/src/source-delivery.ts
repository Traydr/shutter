import {
  buildSourceCacheTag,
  buildSourceDeliveryCacheUrl,
  emitOperationalEvent,
  operationalEvent,
  ProtocolError,
  type SourceDeliveryCacheIdentity,
} from "@shutter/protocol";
import { edgeBrowserResponse, internalEdgeCacheResponse } from "./edge-cache-policy.js";

const CACHE_API_MAX_BYTES = 512 * 1024 * 1024;

type MediaClass = "image" | "video" | "pdf";
type CacheOutcome = "edge-hit" | "origin";
type ByteRangeOutcome = "none" | "edge-hit" | "origin" | "unsatisfied";
type OriginFetchResult =
  | "not-requested"
  | "complete"
  | "partial"
  | "not-modified"
  | "unsatisfied"
  | "rejected"
  | "failed";

type SourceDeliveryIdentity = SourceDeliveryCacheIdentity;

export interface SourceDeliveryInput {
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
  request: Request;
  identity: SourceDeliveryIdentity;
  locator: string;
}

const MEDIA_TYPES = new Map<string, MediaClass>([
  ["image/avif", "image"],
  ["image/gif", "image"],
  ["image/jpeg", "image"],
  ["image/png", "image"],
  ["image/webp", "image"],
  ["video/mp4", "video"],
  ["video/quicktime", "video"],
  ["video/webm", "video"],
  ["application/pdf", "pdf"],
]);

function mediaClassFor(contentType: string | null): MediaClass | undefined {
  if (contentType === null) return undefined;
  return MEDIA_TYPES.get(contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}

function errorResponse(status: 415 | 502, code: "media_unsupported" | "origin_unavailable") {
  return Response.json(
    { error: { code } },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}

function copyBoundedHeader(
  source: Headers,
  target: Headers,
  name: string,
  maximumLength: number,
  isValid: (value: string) => boolean = () => true,
): void {
  const value = source.get(name);
  if (value !== null && value.length <= maximumLength && isValid(value)) target.set(name, value);
}

function isContentLength(value: string): boolean {
  return /^\d{1,16}$/u.test(value) && Number.isSafeInteger(Number(value));
}

type RequestedRange =
  | { type: "from"; start: number; end?: number }
  | { type: "suffix"; length: number };

type ResponseContentRange =
  | { type: "satisfied"; start: number; end: number; total?: number }
  | { type: "unsatisfied"; total: number };

function parseContentRange(value: string): ResponseContentRange | undefined {
  const unsatisfied = /^bytes \*\/(\d{1,16})$/u.exec(value);
  if (unsatisfied !== null) {
    const totalValue = unsatisfied[1] ?? "";
    return isContentLength(totalValue)
      ? { type: "unsatisfied", total: Number(totalValue) }
      : undefined;
  }

  const satisfied = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16}|\*)$/u.exec(value);
  if (satisfied === null) return undefined;
  const [, startValue = "", endValue = "", totalValue = ""] = satisfied;
  if (!isContentLength(startValue) || !isContentLength(endValue)) return undefined;
  const start = Number(startValue);
  const end = Number(endValue);
  if (start > end) return undefined;
  if (totalValue === "*") return { type: "satisfied", start, end };
  if (!isContentLength(totalValue) || end >= Number(totalValue)) return undefined;
  return { type: "satisfied", start, end, total: Number(totalValue) };
}

function parseRequestedRange(value: string): RequestedRange | undefined {
  const match = /^bytes=(\d{0,16})-(\d{0,16})$/u.exec(value);
  if (match === null) return undefined;
  const [, start = "", end = ""] = match;
  if (start === "" && end !== "" && isContentLength(end) && Number(end) > 0) {
    return { type: "suffix", length: Number(end) };
  }
  if (start === "" || !isContentLength(start)) return undefined;
  if (end === "") return { type: "from", start: Number(start) };
  if (!isContentLength(end) || Number(start) > Number(end)) return undefined;
  return { type: "from", start: Number(start), end: Number(end) };
}

function validateRequestHeaders(request: Request): void {
  const range = request.headers.get("range");
  if (range !== null && parseRequestedRange(range) === undefined) {
    throw new ProtocolError("request_invalid", "Source Delivery accepts one valid byte range");
  }
  for (const name of ["if-range", "if-none-match", "if-modified-since"] as const) {
    if ((request.headers.get(name)?.length ?? 0) > 512) {
      throw new ProtocolError("request_invalid", "Source Delivery condition is too large");
    }
  }
}

function validOriginResponse(request: Request, response: Response): boolean {
  if (response.status === 200) return true;
  const requestedRange = parseRequestedRange(request.headers.get("range") ?? "");
  const contentRange = parseContentRange(response.headers.get("content-range") ?? "");
  if (response.status === 206) {
    if (requestedRange === undefined || contentRange?.type !== "satisfied") return false;
    const spanLength = contentRange.end - contentRange.start + 1;
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!isContentLength(contentLength) || Number(contentLength) !== spanLength)
    ) {
      return false;
    }
    if (requestedRange.type === "from") {
      if (contentRange.start !== requestedRange.start) return false;
      if (requestedRange.end !== undefined) {
        const expectedEnd =
          contentRange.total === undefined
            ? requestedRange.end
            : Math.min(requestedRange.end, contentRange.total - 1);
        return contentRange.end === expectedEnd;
      }
      return contentRange.total !== undefined && contentRange.end === contentRange.total - 1;
    }
    if (contentRange.total === undefined || contentRange.total === 0) return false;
    const expectedLength = Math.min(requestedRange.length, contentRange.total);
    return (
      contentRange.start === contentRange.total - expectedLength &&
      contentRange.end === contentRange.total - 1
    );
  }
  if (response.status === 304) {
    return request.headers.has("if-none-match") || request.headers.has("if-modified-since");
  }
  if (response.status === 416) {
    if (requestedRange === undefined || contentRange?.type !== "unsatisfied") return false;
    return requestedRange.type === "from"
      ? requestedRange.start >= contentRange.total
      : contentRange.total === 0;
  }
  return false;
}

function safeOriginHeaders(origin: Response, mediaClass: MediaClass | undefined): Headers {
  const headers = new Headers();
  if (mediaClass !== undefined) {
    const contentType = origin.headers.get("content-type");
    const canonicalType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (canonicalType !== undefined) headers.set("content-type", canonicalType);
    headers.set("content-disposition", "inline");
  }
  if (origin.status !== 304 && origin.status !== 416) {
    copyBoundedHeader(origin.headers, headers, "content-length", 16, isContentLength);
  }
  copyBoundedHeader(
    origin.headers,
    headers,
    "content-range",
    64,
    (value) => parseContentRange(value) !== undefined,
  );
  copyBoundedHeader(origin.headers, headers, "accept-ranges", 16, (value) => value === "bytes");
  copyBoundedHeader(origin.headers, headers, "etag", 256);
  copyBoundedHeader(origin.headers, headers, "last-modified", 128, (value) =>
    Number.isFinite(Date.parse(value)),
  );
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function sourceRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ["range", "if-range", "if-none-match", "if-modified-since"] as const) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

function cacheLookupRequest(request: Request, canonicalUrl: string): Request | undefined {
  if (request.headers.has("if-range")) return undefined;
  const headers = new Headers();
  for (const name of ["range", "if-none-match", "if-modified-since"] as const) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(canonicalUrl, { method: "GET", headers });
}

function cacheable(response: Response, request: Request): boolean {
  if (request.method !== "GET" || request.headers.has("range") || response.status !== 200)
    return false;
  const contentLength = response.headers.get("content-length");
  if (contentLength === null || !isContentLength(contentLength)) return false;
  return Number(contentLength) <= CACHE_API_MAX_BYTES;
}

function rangeOutcome(request: Request, response: Response, cacheOutcome: CacheOutcome) {
  if (!request.headers.has("range")) return "none" satisfies ByteRangeOutcome;
  if (response.status === 416) return "unsatisfied" satisfies ByteRangeOutcome;
  return cacheOutcome satisfies ByteRangeOutcome;
}

function originResult(response: Response): OriginFetchResult {
  if (response.status === 206) return "partial";
  if (response.status === 304) return "not-modified";
  if (response.status === 416) return "unsatisfied";
  return "complete";
}

async function emitDeliveryEvent(
  identity: SourceDeliveryIdentity,
  cacheOutcome: CacheOutcome,
  mediaClass: MediaClass | undefined,
  byteRangeOutcome: ByteRangeOutcome,
  originFetchResult: OriginFetchResult,
): Promise<void> {
  emitOperationalEvent(
    "info",
    await operationalEvent({
      event: "edge.source_delivery",
      spaceId: identity.spaceId,
      sourceId: identity.sourceId,
      fields: {
        routeClass: identity.routeClass,
        cacheOutcome,
        ...(mediaClass === undefined ? {} : { mediaClass }),
        byteRangeOutcome,
        originFetchResult,
      },
    }),
  );
}

export async function deliverSource(input: SourceDeliveryInput): Promise<Response> {
  validateRequestHeaders(input.request);
  const canonicalUrl = await buildSourceDeliveryCacheUrl(input.identity);
  const cacheTag = await buildSourceCacheTag(input.identity.spaceId, input.identity.sourceId);
  const lookupRequest = cacheLookupRequest(input.request, canonicalUrl);
  if (lookupRequest !== undefined) {
    const cached = await caches.default.match(lookupRequest);
    if (cached !== undefined) {
      const mediaClass = mediaClassFor(cached.headers.get("content-type"));
      await emitDeliveryEvent(
        input.identity,
        "edge-hit",
        mediaClass,
        rangeOutcome(input.request, cached, "edge-hit"),
        "not-requested",
      );
      return edgeBrowserResponse(cached, {
        routeClass: input.identity.routeClass,
        cacheStatus: "edge-hit",
        cacheTag,
        head: input.request.method === "HEAD",
      });
    }
  }

  let origin: Response;
  try {
    origin = await fetch(input.locator, {
      method: input.request.method,
      headers: sourceRequestHeaders(input.request),
      redirect: "manual",
    });
  } catch (error) {
    await emitDeliveryEvent(
      input.identity,
      "origin",
      undefined,
      input.request.headers.has("range") ? "origin" : "none",
      "failed",
    );
    throw error;
  }
  if (!validOriginResponse(input.request, origin)) {
    await emitDeliveryEvent(
      input.identity,
      "origin",
      undefined,
      input.request.headers.has("range") ? "origin" : "none",
      "rejected",
    );
    return errorResponse(502, "origin_unavailable");
  }
  const contentEncoding = origin.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding !== "identity") {
    await emitDeliveryEvent(
      input.identity,
      "origin",
      undefined,
      input.request.headers.has("range") ? "origin" : "none",
      "rejected",
    );
    return errorResponse(502, "origin_unavailable");
  }

  const mediaClass = mediaClassFor(origin.headers.get("content-type"));
  if ((origin.status === 200 || origin.status === 206) && mediaClass === undefined) {
    await emitDeliveryEvent(
      input.identity,
      "origin",
      undefined,
      rangeOutcome(input.request, origin, "origin"),
      "rejected",
    );
    return errorResponse(415, "media_unsupported");
  }
  const response = new Response(origin.status === 416 ? null : origin.body, {
    status: origin.status,
    headers: safeOriginHeaders(origin, mediaClass),
  });

  if (cacheable(response, input.request)) {
    const internal = internalEdgeCacheResponse(response, input.identity.routeClass, cacheTag);
    input.executionCtx.waitUntil(
      caches.default.put(new Request(canonicalUrl), internal.clone()).catch(() => undefined),
    );
    await emitDeliveryEvent(
      input.identity,
      "origin",
      mediaClass,
      rangeOutcome(input.request, internal, "origin"),
      originResult(internal),
    );
    return edgeBrowserResponse(internal, {
      routeClass: input.identity.routeClass,
      cacheStatus: "origin",
      cacheTag,
      head: input.request.method === "HEAD",
    });
  }

  await emitDeliveryEvent(
    input.identity,
    "origin",
    mediaClass,
    rangeOutcome(input.request, response, "origin"),
    originResult(response),
  );
  return edgeBrowserResponse(response, {
    routeClass: input.identity.routeClass,
    cacheStatus: "origin",
    cacheTag,
    head: input.request.method === "HEAD",
  });
}
