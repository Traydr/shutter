import {
  buildPreviewJobUrl,
  buildPrivateDeliveryUrl,
  buildPrivateMasterUrl,
  buildPrivateSourceUrl,
  buildPublicLocatedDeliveryUrl,
  buildPublicLocatedSourceUrl,
  buildPublicMasterUrl,
  buildPublicResolverDeliveryUrl,
  buildPublicResolverUrl,
  buildSourcePurgeUrl,
  type CapabilityKeyMaterial,
  decodeCapabilityKey,
  issueSourceCapability,
  type MasterPreviewDescriptor,
  type PreviewKind,
  type SourceCapabilityClaims,
} from "@shutter/protocol";

export type { MasterPreviewDescriptor, PreviewKind };

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

  constructor(
    message: string,
    options?: {
      status?: number | undefined;
      code?: string | undefined;
      retryAfterSeconds?: number | undefined;
    },
  ) {
    super(message);
    this.name = "ShutterClientError";
    this.status = options?.status;
    this.code = options?.code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
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

async function errorFromResponse(response: Response): Promise<ShutterClientError> {
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
  } catch {
    // Non-JSON error bodies keep the HTTP status as the only detail.
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  return new ShutterClientError(`Shutter responded ${response.status}`, {
    status: response.status,
    code,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
  });
}

function parseJobBody(body: unknown, response: Response): PreviewJobResult {
  if (typeof body !== "object" || body === null) {
    throw new ShutterClientError("Shutter returned a malformed job representation", {
      status: response.status,
    });
  }
  const record = body as {
    status?: unknown;
    master?: MasterPreviewDescriptor;
    failure?: { code?: unknown; action?: unknown };
  };
  if (record.status === "pending" || record.status === "processing") {
    return {
      status: record.status,
      retryAfterSeconds: retryAfterSeconds(response),
      location: response.headers.get("location") ?? undefined,
    };
  }
  if (record.status === "ready" && record.master !== undefined) {
    return { status: "ready", master: record.master };
  }
  if (
    record.status === "failed" &&
    typeof record.failure?.code === "string" &&
    typeof record.failure.action === "string"
  ) {
    return {
      status: "failed",
      failure: { code: record.failure.code, action: record.failure.action },
    };
  }
  throw new ShutterClientError("Shutter returned a malformed job representation", {
    status: response.status,
  });
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
    const key =
      typeof keyConfig.key === "string" ? decodeCapabilityKey(keyConfig.key) : keyConfig.key;
    const iat = claims.iat ?? Math.floor(Date.now() / 1000);
    const exp = claims.exp ?? iat + (this.#config.capabilityLifetimeSeconds ?? 300);
    return issueSourceCapability(
      { ...claims, space_id: this.#config.spaceId, iat, exp } as SourceCapabilityClaims,
      { kid: keyConfig.kid, key },
    );
  }

  // Delivery URLs

  publicResolverUrl(
    resolverId: string,
    sourceRef: string,
    parameters: OptimizationParameters,
  ): string {
    return this.#edge(
      buildPublicResolverUrl(this.#config.spaceId, resolverId, sourceRef, parameters),
    );
  }

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

  publicResolverDeliveryUrl(resolverId: string, sourceRef: string): string {
    return this.#edge(buildPublicResolverDeliveryUrl(this.#config.spaceId, resolverId, sourceRef));
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
