import {
  type JsonValue,
  parsePreviewJobSubmission,
  verifyAccessToken,
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

    expect(instance.publicMasterUrl("video", "source/one", { width: 640, quality: 75 })).toBe(
      `/v1/public/${SPACE}/master/video/${encodeURIComponent("source/one")}?w=640&q=75`,
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

describe("v2 resolver sources", () => {
  it("builds delivery URLs, submits jobs with an empty body, and purges by resolver source", async () => {
    const { instance, requests } = client({
      edgeBaseUrl: "https://edge.example.test",
      responses: [
        jsonResponse(202, { status: "pending" }, { "retry-after": "3" }),
        jsonResponse(200, {
          status: "ready",
          master: {
            sourceId: "media/tour.mp4",
            kind: "video",
            width: 1920,
            height: 1080,
            format: "webp",
          },
        }),
        new Response(null, { status: 204 }),
      ],
    });

    expect(
      instance.v2DeliveryUrl({ resolverId: "media", reference: "tour.mp4" }, { width: 640 }),
    ).toBe(`https://edge.example.test/v2/${SPACE}/media/tour.mp4?w=640`);

    const submitted = await instance.submitV2PreviewJob({
      resolverId: "media",
      reference: "tour.mp4",
      kind: "video",
    });
    expect(submitted).toEqual({ status: "pending", retryAfterSeconds: 3, location: undefined });
    expect(requests[0]?.url.toString()).toBe(
      `https://control.example.test/v2/spaces/${SPACE}/sources/media%2Ftour.mp4/previews/video`,
    );
    expect(requests[0]?.init.method).toBe("PUT");
    expect(requests[0]?.init.body).toBe("{}");

    const ready = await instance.getV2PreviewJob(
      { resolverId: "media", reference: "tour.mp4" },
      "video",
    );
    expect(ready).toMatchObject({ status: "ready", master: { sourceId: "media/tour.mp4" } });

    await instance.purgeV2Source({ resolverId: "media", reference: "tour.mp4" });
    expect(requests[2]?.url.toString()).toBe(
      `https://control.example.test/v2/spaces/${SPACE}/sources/media%2Ftour.mp4/purge`,
    );
    expect(requests[2]?.init.method).toBe("POST");
  });

  it("surfaces the problem-details code of a v2 error", async () => {
    const { instance } = client({
      responses: [
        new Response(
          JSON.stringify({
            type: "https://shutter.traydr.dev/problems/not_found",
            title: "Not Found",
            status: 404,
            code: "not_found",
          }),
          { status: 404, headers: { "content-type": "application/problem+json" } },
        ),
      ],
    });
    await expect(
      instance.getV2PreviewJob({ resolverId: "nope", reference: "x" }, "pdf"),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("refuses a reference outside the grammar before any request", async () => {
    const { instance, requests } = client();
    await expect(
      instance.purgeV2Source({ resolverId: "media", reference: "../secret" }),
    ).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});

describe("v2 polling and problems", () => {
  it("polls a v2 Preview Job to ready with the encoded Source ID on every call", async () => {
    const master = {
      sourceId: "ut/proj/f_9",
      kind: "video",
      width: 1920,
      height: 1080,
      format: "webp",
    };
    const { instance, requests } = client({
      responses: [
        jsonResponse(202, { status: "pending" }, { "retry-after": "0" }),
        jsonResponse(200, { status: "ready", master }),
      ],
    });

    const result = await instance.waitForV2PreviewJob({
      resolverId: "ut",
      reference: ["proj", "f_9"],
      kind: "video",
    });

    expect(result).toEqual({ status: "ready", master });
    expect(requests.map((request) => `${request.init.method} ${request.url.pathname}`)).toEqual([
      `PUT /v2/spaces/${SPACE}/sources/ut%2Fproj%2Ff_9/previews/video`,
      `GET /v2/spaces/${SPACE}/sources/ut%2Fproj%2Ff_9/previews/video`,
    ]);
  });

  it("carries the problem's code and requestId on the error", async () => {
    const { instance } = client({
      responses: [
        jsonResponse(503, {
          type: "https://shutter.traydr.dev/problems/service_unavailable",
          title: "Service Unavailable",
          status: 503,
          code: "service_unavailable",
          requestId: "req-42",
        }),
      ],
    });

    await expect(
      instance.purgeV2Source({ resolverId: "media", reference: "k" }),
    ).rejects.toMatchObject({ status: 503, code: "service_unavailable", requestId: "req-42" });
  });
});

describe("v2 private delivery", () => {
  it("mints a token whose purpose and kind follow the requested operation", async () => {
    const { instance } = client({ edgeBaseUrl: "https://edge.example.test" });
    const source = { resolverId: "media", reference: "tour.mp4" };
    const cases = [
      { options: {}, purpose: "source_delivery" as const, kind: undefined },
      { options: { width: 640, quality: 75 }, purpose: "image_source" as const, kind: undefined },
      {
        options: { preview: "video" as const, width: 640 },
        purpose: "master_preview" as const,
        kind: "video" as const,
      },
    ];
    for (const item of cases) {
      const url = new URL(await instance.v2PrivateDeliveryUrl(source, item.options));
      expect(url.pathname).toBe(`/v2/${SPACE}/media/tour.mp4`);
      const token = url.searchParams.get("token") ?? "";
      expect(token.startsWith("v2.")).toBe(true);
      const verification = {
        spaceId: SPACE,
        expectedPurpose: item.purpose,
        expectedSourceId: "media/tour.mp4",
        keys: KEYS,
        now: nowSeconds(),
      };
      const claims = await verifyAccessToken(
        token,
        item.kind === undefined ? verification : { ...verification, expectedKind: item.kind },
      );
      expect(claims.purpose).toBe(item.purpose);
      expect(claims.kind).toBe(item.kind);
    }
  });
});
