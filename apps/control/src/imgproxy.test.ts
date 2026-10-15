import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildImgproxyRequest,
  createImgproxyTransport,
  ImgproxyConfigurationError,
  type ImgproxyTransport,
  parseImgproxyConfig,
} from "./imgproxy.js";

const CONFIG = {
  baseUrl: "http://shutter-imgproxy.railway.internal:8080",
  key: "736563726574",
  salt: "68656c6c6f",
  secret: "s".repeat(32),
};

describe("imgproxy request signing", () => {
  it("locks the signed, width-only WebP request shape", () => {
    const request = buildImgproxyRequest(
      {
        sourceUrl: "https://sources.example.com/private/test image.jpg?token=one",
        width: 640,
        quality: 75,
      },
      parseImgproxyConfig(CONFIG),
    );

    expect(request.url).toBe(
      "http://shutter-imgproxy.railway.internal:8080/r5Knpd_ndnZRzYwoSB9U5jHdr6TSx5ziK0vWptLQkoA/rs:fit:640:0:0/q:75/aHR0cHM6Ly9zb3VyY2VzLmV4YW1wbGUuY29tL3ByaXZhdGUvdGVzdCBpbWFnZS5qcGc_dG9rZW49b25l.webp",
    );
    expect(request.headers.get("authorization")).toBe(`Bearer ${"s".repeat(32)}`);
  });

  it("rejects unsafe sources", () => {
    expect(() =>
      buildImgproxyRequest(
        { sourceUrl: "http://example.com/image.jpg", width: 640, quality: 75 },
        parseImgproxyConfig(CONFIG),
      ),
    ).toThrow("imgproxy source must be HTTPS");
  });

  it("decodes the signing material once and names the variable it cannot use", () => {
    expect(parseImgproxyConfig(CONFIG)).toEqual({
      origin: "http://shutter-imgproxy.railway.internal:8080",
      key: Uint8Array.from(Buffer.from("secret")),
      salt: Uint8Array.from(Buffer.from("hello")),
      authorization: `Bearer ${"s".repeat(32)}`,
    });
    const rejected = [
      [{ ...CONFIG, key: "not-hex" }, "IMGPROXY_KEY"],
      [{ ...CONFIG, salt: "abc" }, "IMGPROXY_SALT"],
      [{ ...CONFIG, baseUrl: "http://imgproxy.internal:8080/path" }, "IMGPROXY_BASE_URL"],
      [{ ...CONFIG, secret: "short" }, "IMGPROXY_SECRET"],
    ] as const;
    for (const [config, variable] of rejected) {
      expect(() => parseImgproxyConfig(config)).toThrow(
        expect.objectContaining({ name: "ImgproxyConfigurationError", variable }),
      );
      expect(() => parseImgproxyConfig(config)).toThrow(ImgproxyConfigurationError);
    }
  });
});

interface TestServer {
  url: string;
  /** The client port of every request, in arrival order: one port per connection. */
  ports: number[];
  /** Requests whose connection closed before the response finished. */
  abandoned: () => number;
  close(): Promise<void>;
}

async function startServer(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  const ports: number[] = [];
  let abandoned = 0;
  const server = createServer((request, response) => {
    ports.push(request.socket.remotePort ?? 0);
    response.on("close", () => {
      if (!response.writableFinished) abandoned += 1;
    });
    respond(request, response);
  });
  // imgproxy's own default: an idle connection closes after ten seconds.
  server.keepAliveTimeout = 10_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: listen(0, host) resolved, so the server is bound to a TCP address.
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    ports,
    abandoned: () => abandoned,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function init(signal = new AbortController().signal) {
  return {
    headers: new Headers({ authorization: "Bearer test" }),
    redirect: "error",
    signal,
  } as const;
}

describe("imgproxy transport", () => {
  let server: TestServer | undefined;
  let transport: ImgproxyTransport | undefined;

  afterEach(async () => {
    transport?.close();
    await server?.close();
  });

  it("streams the body with its headers and reuses one connection", async () => {
    let authorization: string | undefined;
    server = await startServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "image/webp", "content-length": "4" });
      response.end("RIFF");
    });
    transport = createImgproxyTransport();

    for (let round = 0; round < 3; round += 1) {
      const response = await transport.fetch(`${server.url}/signed/path`, init());
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("content-length")).toBe("4");
      expect(await response.text()).toBe("RIFF");
    }

    expect(authorization).toBe("Bearer test");
    expect(new Set(server.ports).size).toBe(1);
  });

  it("closes an idle connection before imgproxy would", async () => {
    server = await startServer((_request, response) => response.end("ok"));
    transport = createImgproxyTransport({ idleSocketTimeoutMs: 50 });

    await (await transport.fetch(`${server.url}/one`, init())).text();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await (await transport.fetch(`${server.url}/two`, init())).text();

    expect(new Set(server.ports).size).toBe(2);
  });

  it("keeps a connection that is waiting on a slow render open past the idle limit", async () => {
    server = await startServer((_request, response) => {
      setTimeout(() => response.end("rendered"), 200);
    });
    transport = createImgproxyTransport({ idleSocketTimeoutMs: 50 });

    const response = await transport.fetch(`${server.url}/slow`, init());

    expect(await response.text()).toBe("rendered");
  });

  it("abandons the imgproxy request when the caller's signal aborts", async () => {
    server = await startServer(() => {
      // Never answers: the render is still running when the caller leaves.
    });
    transport = createImgproxyTransport();
    const controller = new AbortController();

    const pending = transport.fetch(`${server.url}/abandoned`, init(controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await expect(pending).rejects.toThrow();
    await expect.poll(() => server?.abandoned()).toBe(1);
  });

  it("refuses an encoded body rather than pass on bytes it cannot describe", async () => {
    let acceptEncoding: string | undefined;
    server = await startServer((request, response) => {
      acceptEncoding = request.headers["accept-encoding"];
      response.writeHead(200, { "content-type": "image/webp", "content-encoding": "gzip" });
      response.end("compressed");
    });
    transport = createImgproxyTransport();

    await expect(transport.fetch(`${server.url}/encoded`, init())).rejects.toThrow(
      "imgproxy answered with an encoding Control did not ask for",
    );
    expect(acceptEncoding).toBeUndefined();
  });

  it("passes a non-OK status through for the caller to fail", async () => {
    server = await startServer((_request, response) => {
      response.writeHead(422);
      response.end("bad source");
    });
    transport = createImgproxyTransport();

    const response = await transport.fetch(`${server.url}/rejected`, init());

    expect(response.status).toBe(422);
    expect(response.ok).toBe(false);
  });
});
