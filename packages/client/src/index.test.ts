import {
  type JsonValue,
  parsePreviewJobSubmission,
  verifySourceCapability,
} from "@shutter/protocol";
import { describe, expect, it } from "vitest";
import { createShutterClient, ShutterClientError } from "./index.js";

const KID = "key-2026-08";
const KEY = new Uint8Array(32).fill(7);
const SPACE = "example-private";
const SOURCE = "media_01H8EXAMPLE";
const LOCATOR = "https://storage.example.test/objects/one?signature=abc";
const KEYS = new Map([[KID, KEY]]);

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

interface RecordedRequest {
  url: URL;
  init: RequestInit;
}

interface FetchStub {
  requests: RecordedRequest[];
  fetch: typeof globalThis.fetch;
}

interface ClientHarness {
  requests: RecordedRequest[];
  instance: ReturnType<typeof createShutterClient>;
}

function fetchStub(responses: Response[]): FetchStub {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push({ url: new URL(String(input)), init: init ?? {} });
      const next = responses.shift();
      if (next === undefined) throw new Error("fetch stub exhausted");
      return next;
    },
  };
}

function client(overrides?: { responses?: Response[]; edgeBaseUrl?: string }): ClientHarness {
  const stub = fetchStub(overrides?.responses ?? []);
  return {
    requests: stub.requests,
    instance: createShutterClient({
      spaceId: SPACE,
      controlBaseUrl: "https://control.example.test",
      edgeBaseUrl: overrides?.edgeBaseUrl,
      spaceApiToken: "space-token",
      capabilityKey: { kid: KID, key: KEY },
      fetch: stub.fetch,
    }),
  };
}

function jsonResponse(status: number, body: JsonValue, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("preview jobs", () => {
  it("submits with the Space credential and a verifiable preview_job capability", async () => {
    const { instance, requests } = client({
      responses: [jsonResponse(202, { status: "pending" }, { "retry-after": "7" })],
    });

    const result = await instance.submitPreviewJob({
      sourceId: SOURCE,
      kind: "video",
      locator: LOCATOR,
    });

    expect(result).toEqual({ status: "pending", retryAfterSeconds: 7, location: undefined });
    const request = requests[0];
    expect(request?.url.toString()).toBe(
      `https://control.example.test/v1/spaces/${SPACE}/sources/${encodeURIComponent(SOURCE)}/previews/video`,
    );
    expect(request?.init.method).toBe("PUT");
    expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer space-token");

    const submission = parsePreviewJobSubmission(JSON.parse(String(request?.init.body)));
    const claims = await verifySourceCapability(submission.sourceCapability, {
      spaceId: SPACE,
      expectedPurpose: "preview_job",
      keys: KEYS,
      now: nowSeconds(),
      allowedSourceOrigins: [{ origin: "https://storage.example.test" }],
      expectedSourceId: SOURCE,
      expectedKind: "video",
    });
    expect(claims.locator).toBe(LOCATOR);
  });

  it("returns the ready master descriptor", async () => {
    const master = { sourceId: SOURCE, kind: "pdf", width: 1400, height: 1980, format: "webp" };
    const { instance } = client({ responses: [jsonResponse(200, { status: "ready", master })] });

    const result = await instance.getPreviewJob(SOURCE, "pdf");

    expect(result).toEqual({ status: "ready", master });
  });

  it("surfaces a persisted failure as job state, not an exception", async () => {
    const { instance } = client({
      responses: [
        jsonResponse(200, {
          status: "failed",
          failure: { code: "source_expired", action: "resubmit_with_fresh_capability" },
        }),
      ],
    });

    const result = await instance.getPreviewJob(SOURCE, "video");

    expect(result.status).toBe("failed");
  });

  it("polls until ready in waitForPreviewJob honoring Retry-After", async () => {
    const master = { sourceId: SOURCE, kind: "video", width: 1920, height: 1080, format: "webp" };
    const { instance, requests } = client({
      responses: [
        jsonResponse(202, { status: "pending" }, { "retry-after": "0" }),
        jsonResponse(202, { status: "processing" }, { "retry-after": "0" }),
        jsonResponse(200, { status: "ready", master }),
      ],
    });

    const result = await instance.waitForPreviewJob({
      sourceId: SOURCE,
      kind: "video",
      locator: LOCATOR,
    });

    expect(result).toEqual({ status: "ready", master });
    expect(requests.map((request) => request.init.method)).toEqual(["PUT", "GET", "GET"]);
  });

  it("throws a typed error for authentication failures", async () => {
    const { instance } = client({
      responses: [jsonResponse(401, { error: { code: "unauthorized" } })],
    });

    await expect(instance.getPreviewJob(SOURCE, "video")).rejects.toMatchObject({
      name: "ShutterClientError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("source purge", () => {
  it("treats 204 as success", async () => {
    const { instance, requests } = client({ responses: [new Response(null, { status: 204 })] });

    await instance.purgeSource(SOURCE);

    expect(requests[0]?.url.pathname).toBe(
      `/v1/spaces/${SPACE}/sources/${encodeURIComponent(SOURCE)}/purge`,
    );
    expect(requests[0]?.init.method).toBe("POST");
  });

  it("throws on any other status", async () => {
    const { instance } = client({
      responses: [jsonResponse(503, { error: { code: "service_unavailable" } })],
    });

    await expect(instance.purgeSource(SOURCE)).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
  });
});

describe("delivery URLs", () => {
  it("builds an absolute private source URL with a verifiable image_source capability", async () => {
    const { instance } = client({ edgeBaseUrl: "https://media.example.test" });

    const url = new URL(
      await instance.privateSourceUrl(
        { sourceId: SOURCE, locator: LOCATOR },
        { width: 1200, quality: 75 },
      ),
    );

    expect(url.origin).toBe("https://media.example.test");
    expect(url.searchParams.get("w")).toBe("1200");
    expect(url.searchParams.get("q")).toBe("75");
    const capability = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    const claims = await verifySourceCapability(capability, {
      spaceId: SPACE,
      expectedPurpose: "image_source",
      keys: KEYS,
      now: nowSeconds(),
      allowedSourceOrigins: [{ origin: "https://storage.example.test" }],
      expectedSourceId: SOURCE,
    });
    expect(claims.locator).toBe(LOCATOR);
  });

  it("builds a private master URL bound to the preview kind", async () => {
    const { instance } = client({ edgeBaseUrl: "https://media.example.test" });

    const url = new URL(
      await instance.privateMasterUrl(
        { sourceId: SOURCE, kind: "pdf" },
        { width: 640, quality: 50 },
      ),
    );

    const capability = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    await verifySourceCapability(capability, {
      spaceId: SPACE,
      expectedPurpose: "master_preview",
      keys: KEYS,
      now: nowSeconds(),
      expectedSourceId: SOURCE,
      expectedKind: "pdf",
    });
  });

  it("returns relative paths when no edge base URL is configured", () => {
    const { instance } = client();

    expect(
      instance.publicResolverUrl("uploadthing", "project/file", { width: 640, quality: 75 }),
    ).toBe(
      `/v1/public/${SPACE}/resolver/uploadthing/${encodeURIComponent("project/file")}?w=640&q=75`,
    );
  });
});

describe("configuration guards", () => {
  it("refuses control calls without an API token", async () => {
    const instance = createShutterClient({
      spaceId: SPACE,
      controlBaseUrl: "https://control.example.test",
      capabilityKey: { kid: KID, key: KEY },
    });

    await expect(instance.getPreviewJob(SOURCE, "video")).rejects.toThrow(ShutterClientError);
  });

  it("refuses capability issuance without a Capability Key", async () => {
    const instance = createShutterClient({ spaceId: SPACE });

    await expect(
      instance.privateSourceUrl(
        { sourceId: SOURCE, locator: LOCATOR },
        { width: 640, quality: 75 },
      ),
    ).rejects.toThrow(ShutterClientError);
  });
});
