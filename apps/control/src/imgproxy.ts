import { createHmac } from "node:crypto";
import { Agent, request as httpRequest } from "node:http";

/** The imgproxy variables as the environment supplies them. */
export interface ImgproxyConfig {
  baseUrl: string;
  key: string;
  salt: string;
  secret: string;
}

/**
 * The imgproxy configuration decoded once, at boot: the origin, the signing
 * key and salt as bytes, and the authorization header. Every optimization
 * signs with these, so a malformed value fails the boot instead of every
 * request.
 */
export interface ImgproxyEndpoint {
  origin: string;
  key: Uint8Array;
  salt: Uint8Array;
  authorization: string;
}

export type ImgproxyVariable =
  | "IMGPROXY_BASE_URL"
  | "IMGPROXY_KEY"
  | "IMGPROXY_SALT"
  | "IMGPROXY_SECRET";

/** A supplied imgproxy variable that cannot be used; names the variable, never its value. */
export class ImgproxyConfigurationError extends Error {
  readonly variable: ImgproxyVariable;

  constructor(variable: ImgproxyVariable, message: string) {
    super(message);
    this.name = "ImgproxyConfigurationError";
    this.variable = variable;
  }
}

export interface ImgproxyOptimization {
  sourceUrl: string;
  width: number;
  quality: number;
}

/**
 * How long Control waits for imgproxy: past imgproxy's own `IMGPROXY_TIMEOUT`
 * of 45 seconds (`.railway/railway.ts`), so imgproxy answers its own timeout
 * first, and no longer, so an exchange that imgproxy has abandoned does not
 * hold the request open.
 */
export const IMGPROXY_REQUEST_TIMEOUT_MS = 50_000;

/**
 * How long an idle connection to imgproxy stays in the pool. imgproxy closes a
 * connection idle for `IMGPROXY_KEEP_ALIVE_TIMEOUT`, 10 seconds by default;
 * reusing a socket the server is closing fails the request, so Control lets
 * go first.
 */
export const IMGPROXY_IDLE_SOCKET_TIMEOUT_MS = 8_000;

function decodeHex(variable: "IMGPROXY_KEY" | "IMGPROXY_SALT", value: string): Uint8Array {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(value)) {
    throw new ImgproxyConfigurationError(variable, `${variable} must be non-empty hexadecimal`);
  }

  return Uint8Array.from(Buffer.from(value, "hex"));
}

function imgproxyOrigin(value: string): string {
  const url = URL.parse(value);
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ImgproxyConfigurationError(
      "IMGPROXY_BASE_URL",
      "IMGPROXY_BASE_URL must be an HTTP(S) origin",
    );
  }

  return url.origin;
}

export function parseImgproxyConfig(config: ImgproxyConfig): ImgproxyEndpoint {
  if (config.secret.length < 32) {
    throw new ImgproxyConfigurationError(
      "IMGPROXY_SECRET",
      "IMGPROXY_SECRET must be at least 32 characters",
    );
  }

  return {
    origin: imgproxyOrigin(config.baseUrl),
    key: decodeHex("IMGPROXY_KEY", config.key),
    salt: decodeHex("IMGPROXY_SALT", config.salt),
    authorization: `Bearer ${config.secret}`,
  };
}

function validateOptimization({ sourceUrl, width, quality }: ImgproxyOptimization): void {
  const source = new URL(sourceUrl);
  if (
    source.protocol !== "https:" ||
    source.username !== "" ||
    source.password !== "" ||
    source.hash !== ""
  ) {
    throw new Error("imgproxy source must be HTTPS without credentials or a fragment");
  }
  if (!Number.isSafeInteger(width) || width <= 0) throw new Error("width must be positive");
  if (!Number.isSafeInteger(quality) || quality <= 0 || quality > 100) {
    throw new Error("quality must be between 1 and 100");
  }
}

export interface ImgproxyRequest {
  url: string;
  headers: Headers;
}

export function buildImgproxyRequest(
  optimization: ImgproxyOptimization,
  endpoint: ImgproxyEndpoint,
): ImgproxyRequest {
  validateOptimization(optimization);

  const source = Buffer.from(optimization.sourceUrl, "utf8").toString("base64url");
  const processingPath = `/rs:fit:${optimization.width}:0:0/q:${optimization.quality}/${source}.webp`;
  const signature = createHmac("sha256", endpoint.key)
    .update(endpoint.salt)
    .update(processingPath)
    .digest("base64url");

  return {
    url: `${endpoint.origin}/${signature}${processingPath}`,
    headers: new Headers({ authorization: endpoint.authorization }),
  };
}

/** Sends one imgproxy request; `fetch` satisfies it, and so does the keep-alive transport. */
export type ImgproxyFetch = (
  url: string,
  init: { headers: Headers; redirect: "error"; signal: AbortSignal },
) => Promise<Response>;

export interface ImgproxyTransport {
  fetch: ImgproxyFetch;
  /** Closes the pooled connections. */
  close(): void;
}

/**
 * The imgproxy transport: `node:http` over a dedicated keep-alive agent whose
 * idle sockets expire before imgproxy's do. Node's global `fetch` takes no
 * agent without the `undici` package; this needs no dependency. A response
 * is never a redirect to follow, matching `redirect: "error"`: imgproxy does
 * not redirect, and any 3xx fails the optimization as a non-OK status. On
 * Bun, `node:http` runs on Bun's own connection pool and ignores the agent's
 * tuning, which is harmless.
 */
export function createImgproxyTransport(
  options: { idleSocketTimeoutMs?: number } = {},
): ImgproxyTransport {
  // An agent's `timeout` is the idle limit of its free sockets: the agent
  // destroys a pooled socket that times out, while a socket that is waiting
  // on a slow render only reports the timeout and stays open.
  const agent = new Agent({
    keepAlive: true,
    timeout: options.idleSocketTimeoutMs ?? IMGPROXY_IDLE_SOCKET_TIMEOUT_MS,
  });

  return {
    fetch(url, init) {
      return new Promise<Response>((resolve, reject) => {
        const outgoing = httpRequest(
          url,
          { agent, method: "GET", headers: Object.fromEntries(init.headers), signal: init.signal },
          (incoming) => {
            // The request asks for no encoding and `node:http` decodes none, so
            // an encoded body would reach the Edge as corrupt image bytes.
            const encoding = incoming.headers["content-encoding"];
            if (encoding !== undefined && encoding !== "identity") {
              incoming.destroy();
              reject(new Error("imgproxy answered with an encoding Control did not ask for"));
              return;
            }
            const headers = new Headers();
            for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
              const name = incoming.rawHeaders[index];
              const value = incoming.rawHeaders[index + 1];
              if (name !== undefined && value !== undefined) headers.append(name, value);
            }
            const chunks: AsyncIterator<Buffer> = incoming[Symbol.asyncIterator]();
            const body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                const chunk = await chunks.next();
                if (chunk.done === true) {
                  controller.close();
                } else {
                  controller.enqueue(chunk.value);
                }
              },
              cancel() {
                incoming.destroy();
              },
            });
            try {
              resolve(new Response(body, { status: incoming.statusCode ?? 502, headers }));
            } catch (error) {
              // A status `Response` cannot carry (a 1xx, or a body on a 204).
              incoming.destroy();
              reject(error);
            }
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
    },
    close() {
      agent.destroy();
    },
  };
}
