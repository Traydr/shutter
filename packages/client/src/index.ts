import {
  type AccessTokenClaims,
  buildPreviewJobUrl,
  buildPrivateDeliveryUrl,
  buildPrivateMasterUrl,
  buildPrivateSourceUrl,
  buildPublicLocatedDeliveryUrl,
  buildPublicLocatedSourceUrl,
  buildPublicMasterUrl,
  buildSourcePurgeUrl,
  buildV2DeliveryUrl,
  buildV2PreviewJobUrl,
  buildV2SourcePurgeUrl,
  type CapabilityKeyMaterial,
  type DeliveryUrlOptions,
  decodeCapabilityKey,
  issueAccessToken,
  issueSourceCapability,
  type JsonValue,
  type MasterPreviewDescriptor,
  type PreviewKind,
  SHUTTER_FORMAT,
  type SourceCapabilityClaims,
} from "@shutter/protocol";
import { z } from "zod";
import { sourceIdFor } from "./urls.js";

export {
  type DeliverySource,
  deliveryUrl,
  isDeliveryUrl,
  sourceIdFor,
  transformDeliveryUrl,
} from "./urls.js";
export type { DeliveryUrlOptions, MasterPreviewDescriptor, PreviewKind };

/** Omit that distributes over each member of a union of object types. */
export type DistributedOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface OptimizationParameters {
  width: number;
  quality: number;
}

export interface CapabilityKeyConfig {
  kid: string;
  /** Raw key material, or the base64url string form stored in configuration. */
  key: CapabilityKeyMaterial | string;
}

export interface ShutterClientConfig {
  spaceId: string;
  /** Base URL of Shutter Control. Required for Preview Jobs and Source Purge. */
  controlBaseUrl?: string | undefined;
  /** Base URL of the delivery edge. When set, URL helpers return absolute URLs. */
  edgeBaseUrl?: string | undefined;
  /** Space API token for the job and purge endpoints. */
  spaceApiToken?: string | undefined;
  /** Capability Key for issuing Source Capabilities. */
  capabilityKey?: CapabilityKeyConfig | undefined;
  /** Lifetime of issued capabilities in seconds. Defaults to 300. */
  capabilityLifetimeSeconds?: number | undefined;
  /** Per-request timeout in milliseconds. Defaults to 10000. */
  requestTimeoutMs?: number | undefined;
  /** Fetch implementation override, mainly for tests. */
  fetch?: typeof globalThis.fetch | undefined;
}

export type PreviewJobResult =
  | { status: "pending" | "processing"; retryAfterSeconds: number; location?: string | undefined }
  | { status: "ready"; master: MasterPreviewDescriptor }
  | { status: "failed"; failure: { code: string; action: string } };

export class ShutterClientError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  /** Parsed Retry-After header when the failing response carried one. */
  readonly retryAfterSeconds: number | undefined;
  /** The v2 problem's request ID, the handle an operator finds the redacted log event by. */
  readonly requestId: string | undefined;

  constructor(
    message: string,
    options?: {
      status?: number | undefined;
      code?: string | undefined;
      retryAfterSeconds?: number | undefined;
      requestId?: string | undefined;
    },
  ) {
    super(message);
    this.name = "ShutterClientError";
    this.status = options?.status;
    this.code = options?.code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.requestId = options?.requestId;
  }
}

interface SourceInput {
  sourceId: string;
  /** How Shutter may fetch the original, such as a presigned HTTPS GET URL. */
  locator: string;
}

interface PreviewInput extends SourceInput {
  kind: PreviewKind;
}

/** A resolver source: the resolver's identifier and one reference value per placeholder. */
export interface ResolverSource {
  resolverId: string;
  reference: string | readonly string[];
}

interface ResolverPreviewInput extends ResolverSource {
  kind: PreviewKind;
}

function referenceSegments(reference: string | readonly string[]): readonly string[] {
  return Array.isArray(reference) ? reference : [String(reference)];
}

interface WaitOptions {
  /** Abort polling; the last observed representation is discarded. */
  signal?: AbortSignal | undefined;
  /** Give up after this many milliseconds. Defaults to 120000. */
  maxWaitMs?: number | undefined;
}

function requireConfig<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new ShutterClientError(`ShutterClient requires ${name} for this call`);
  }
  return value;
}

function retryAfterSeconds(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 5;
}

/**
 * What the client surfaces from a Shutter error body: the v1
 * `{ error: { code } }`, or the v2 problem-details `code` and `requestId`.
 */
const errorBodySchema = z.union([
  z
    .object({ error: z.object({ code: z.string() }) })
    .transform((body) => ({ code: body.error.code, requestId: undefined })),
  z
    .object({ code: z.string(), requestId: z.string().optional() })
    .transform((body) => ({ code: body.code, requestId: body.requestId })),
]);

const masterPreviewSchema = z.object({
  sourceId: z.string(),
  kind: z.enum(["video", "pdf"]),
  width: z.number(),
  height: z.number(),
  format: z.literal(SHUTTER_FORMAT),
});

/**
 * The Preview Job representation as Control serves it. Fields the client does
 * not read are ignored so a newer Control can add to the representation.
 */
const jobRepresentationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["pending", "processing"]) }),
  z.object({ status: z.literal("ready"), master: masterPreviewSchema }),
  z.object({
    status: z.literal("failed"),
    failure: z.object({ code: z.string(), action: z.string() }),
  }),
]);

async function errorFromResponse(response: Response): Promise<ShutterClientError> {
  let code: string | undefined;
  let requestId: string | undefined;
  try {
    const body = errorBodySchema.safeParse(await response.json());
    if (body.success) ({ code, requestId } = body.data);
  } catch {
    // Non-JSON error bodies keep the HTTP status as the only detail.
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  return new ShutterClientError(`Shutter responded ${response.status}`, {
    status: response.status,
    code,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
    requestId,
  });
}

function parseJobBody(body: JsonValue, response: Response): PreviewJobResult {
  const parsed = jobRepresentationSchema.safeParse(body);
  if (!parsed.success) {
    throw new ShutterClientError("Shutter returned a malformed job representation", {
      status: response.status,
    });
  }
  const record = parsed.data;
  switch (record.status) {
    case "pending":
    case "processing":
      return {
        status: record.status,
        retryAfterSeconds: retryAfterSeconds(response),
        location: response.headers.get("location") ?? undefined,
      };
    case "ready":
      return { status: "ready", master: record.master };
    case "failed":
      return { status: "failed", failure: record.failure };
  }
}

/** Configuration accepts raw key material or its base64url string form. */
function keyMaterial(key: CapabilityKeyMaterial | string): CapabilityKeyMaterial {
  if (ArrayBuffer.isView(key) || key instanceof CryptoKey) return key;
  return decodeCapabilityKey(key);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new ShutterClientError("Preview Job polling was aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ShutterClient {
  readonly #config: ShutterClientConfig;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: ShutterClientConfig) {
    this.#config = config;
    // Late-bound so test harnesses that stub globalThis.fetch after
    // construction are still observed.
    this.#fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  // Capabilities

  async issueCapability(
    claims: DistributedOmit<SourceCapabilityClaims, "space_id" | "iat" | "exp"> & {
      iat?: number | undefined;
      exp?: number | undefined;
    },
  ): Promise<string> {
    const keyConfig = requireConfig(this.#config.capabilityKey, "capabilityKey");
    const key = keyMaterial(keyConfig.key);
    const iat = claims.iat ?? Math.floor(Date.now() / 1000);
    const exp = claims.exp ?? iat + (this.#config.capabilityLifetimeSeconds ?? 300);
    // SAFETY: `claims` is one member of the union minus the fields restored
    // here; TypeScript cannot re-attach the shared fields to a distributed Omit.
    const fullClaims = {
      ...claims,
      space_id: this.#config.spaceId,
      iat,
      exp,
    } as SourceCapabilityClaims;
    return issueSourceCapability(fullClaims, { kid: keyConfig.kid, key });
  }

  // Delivery URLs

  async publicLocatedSourceUrl(
    input: SourceInput,
    parameters: OptimizationParameters,
  ): Promise<string> {
    const capability = await this.issueCapability({
      source_id: input.sourceId,
      purpose: "image_source",
      locator: input.locator,
    });
    return this.#edge(
      buildPublicLocatedSourceUrl(this.#config.spaceId, input.sourceId, capability, parameters),
    );
  }

  publicMasterUrl(kind: PreviewKind, sourceId: string, parameters: OptimizationParameters): string {
    return this.#edge(buildPublicMasterUrl(this.#config.spaceId, kind, sourceId, parameters));
  }

  async publicLocatedDeliveryUrl(input: SourceInput): Promise<string> {
    const capability = await this.issueCapability({
      source_id: input.sourceId,
      purpose: "source_delivery",
      locator: input.locator,
    });
    return this.#edge(
      buildPublicLocatedDeliveryUrl(this.#config.spaceId, input.sourceId, capability),
    );
  }

  async privateSourceUrl(input: SourceInput, parameters: OptimizationParameters): Promise<string> {
    const capability = await this.issueCapability({
      source_id: input.sourceId,
      purpose: "image_source",
      locator: input.locator,
    });
    return this.#edge(buildPrivateSourceUrl(this.#config.spaceId, capability, parameters));
  }

  async privateMasterUrl(
    input: { sourceId: string; kind: PreviewKind },
    parameters: OptimizationParameters,
  ): Promise<string> {
    const capability = await this.issueCapability({
      source_id: input.sourceId,
      purpose: "master_preview",
      kind: input.kind,
    });
    return this.#edge(buildPrivateMasterUrl(this.#config.spaceId, capability, parameters));
  }

  async privateDeliveryUrl(input: SourceInput): Promise<string> {
    const capability = await this.issueCapability({
      source_id: input.sourceId,
      purpose: "source_delivery",
      locator: input.locator,
    });
    return this.#edge(buildPrivateDeliveryUrl(this.#config.spaceId, capability));
  }

  // v2: resolver sources, no capability

  /**
   * Mints a v2 access token for a private Space with the Capability Key
   * (ADR 0028): no locator, one purpose, and the kind for a Master Preview.
   */
  async issueAccessToken(
    claims: Omit<AccessTokenClaims, "space_id" | "iat" | "exp"> & {
      iat?: number | undefined;
      exp?: number | undefined;
    },
  ): Promise<string> {
    const keyConfig = requireConfig(this.#config.capabilityKey, "capabilityKey");
    const iat = claims.iat ?? Math.floor(Date.now() / 1000);
    const exp = claims.exp ?? iat + (this.#config.capabilityLifetimeSeconds ?? 300);
    const full: AccessTokenClaims = {
      space_id: this.#config.spaceId,
      source_id: claims.source_id,
      purpose: claims.purpose,
      iat,
      exp,
    };
    if (claims.kind !== undefined) full.kind = claims.kind;
    return issueAccessToken(full, { kid: keyConfig.kid, key: keyMaterial(keyConfig.key) });
  }

  /**
   * A private Space's v2 Delivery URL: the token's purpose follows the
   * options, so a delivery grant, an optimization grant, and a preview grant
   * can never be mixed up.
   */
  async v2PrivateDeliveryUrl(
    source: ResolverSource,
    options: Omit<DeliveryUrlOptions, "token"> = {},
  ): Promise<string> {
    const sourceId = sourceIdFor(source.resolverId, source.reference);
    const token =
      options.preview !== undefined
        ? await this.issueAccessToken({
            source_id: sourceId,
            purpose: "master_preview",
            kind: options.preview,
          })
        : options.width !== undefined
          ? await this.issueAccessToken({ source_id: sourceId, purpose: "image_source" })
          : await this.issueAccessToken({ source_id: sourceId, purpose: "source_delivery" });
    return this.v2DeliveryUrl(source, { ...options, token });
  }

  /** `/v2/{space}/{resolver}/{reference}` with the canonical query; see `@shutter/client/urls`. */
  v2DeliveryUrl(source: ResolverSource, options: DeliveryUrlOptions = {}): string {
    return this.#edge(
      buildV2DeliveryUrl(
        this.#config.spaceId,
        source.resolverId,
        referenceSegments(source.reference),
        options,
      ),
    );
  }

  /** Submits a Preview Job for a resolver source. Needs the Space API token and nothing else. */
  async submitV2PreviewJob(input: ResolverPreviewInput): Promise<PreviewJobResult> {
    const sourceId = sourceIdFor(input.resolverId, input.reference);
    const response = await this.#control(
      buildV2PreviewJobUrl(this.#config.spaceId, sourceId, input.kind),
      { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" },
    );
    return this.#jobResult(response);
  }

  async getV2PreviewJob(source: ResolverSource, kind: PreviewKind): Promise<PreviewJobResult> {
    const sourceId = sourceIdFor(source.resolverId, source.reference);
    const response = await this.#control(
      buildV2PreviewJobUrl(this.#config.spaceId, sourceId, kind),
      { method: "GET" },
    );
    return this.#jobResult(response);
  }

  async waitForV2PreviewJob(
    input: ResolverPreviewInput,
    options?: WaitOptions,
  ): Promise<PreviewJobResult> {
    const deadline = Date.now() + (options?.maxWaitMs ?? 120_000);
    let result = await this.submitV2PreviewJob(input);
    while (result.status === "pending" || result.status === "processing") {
      if (Date.now() >= deadline) return result;
      await sleep(result.retryAfterSeconds * 1000, options?.signal);
      result = await this.getV2PreviewJob(input, input.kind);
    }
    return result;
  }

  /** Purges everything Shutter holds for a resolver source: `{resolver}/{reference}`. */
  async purgeV2Source(source: ResolverSource): Promise<void> {
    const sourceId = sourceIdFor(source.resolverId, source.reference);
    const response = await this.#control(buildV2SourcePurgeUrl(this.#config.spaceId, sourceId), {
      method: "POST",
    });
    if (response.status !== 204) throw await errorFromResponse(response);
  }

  // Preview Jobs

  async submitPreviewJob(input: PreviewInput): Promise<PreviewJobResult> {
    const sourceCapability = await this.issueCapability({
      source_id: input.sourceId,
      purpose: "preview_job",
      kind: input.kind,
      locator: input.locator,
    });
    const response = await this.#control(
      buildPreviewJobUrl(this.#config.spaceId, input.sourceId, input.kind),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceCapability }),
      },
    );
    return this.#jobResult(response);
  }

  async getPreviewJob(sourceId: string, kind: PreviewKind): Promise<PreviewJobResult> {
    const response = await this.#control(buildPreviewJobUrl(this.#config.spaceId, sourceId, kind), {
      method: "GET",
    });
    return this.#jobResult(response);
  }

  /**
   * Submits the job, then polls the canonical GET honoring Retry-After until
   * the job reaches ready or a persisted failed representation.
   */
  async waitForPreviewJob(input: PreviewInput, options?: WaitOptions): Promise<PreviewJobResult> {
    const deadline = Date.now() + (options?.maxWaitMs ?? 120_000);
    let result = await this.submitPreviewJob(input);
    while (result.status === "pending" || result.status === "processing") {
      if (Date.now() >= deadline) return result;
      await sleep(result.retryAfterSeconds * 1000, options?.signal);
      result = await this.getPreviewJob(input.sourceId, input.kind);
    }
    return result;
  }

  // Source Purge

  async purgeSource(sourceId: string): Promise<void> {
    const response = await this.#control(buildSourcePurgeUrl(this.#config.spaceId, sourceId), {
      method: "POST",
    });
    if (response.status !== 204) throw await errorFromResponse(response);
  }

  async #jobResult(response: Response): Promise<PreviewJobResult> {
    if (response.status !== 200 && response.status !== 202) {
      throw await errorFromResponse(response);
    }
    return parseJobBody(await response.json(), response);
  }

  async #control(path: string, init: RequestInit): Promise<Response> {
    const base = requireConfig(this.#config.controlBaseUrl, "controlBaseUrl");
    const token = requireConfig(this.#config.spaceApiToken, "spaceApiToken");
    return this.#fetch(new URL(path, base), {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(this.#config.requestTimeoutMs ?? 10_000),
    });
  }

  #edge(path: string): string {
    const base = this.#config.edgeBaseUrl;
    return base === undefined ? path : new URL(path, base).toString();
  }
}

export function createShutterClient(config: ShutterClientConfig): ShutterClient {
  return new ShutterClient(config);
}
