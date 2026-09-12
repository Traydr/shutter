import type { SourceResolverService } from "../source-resolvers.js";
import type { SpaceRecord } from "../spaces/registry.js";
import {
  type AddressLookup,
  assertPublicHost,
  displayMediaType,
  type LocationProbe,
  type ProbeLocation,
  probeLocation as probeOverHttps,
} from "./address-guard.js";

const RESOLVER_TEST_TIMEOUT_MS = 5_000;
const RESOLVER_TEST_LIFETIME_SECONDS = 60;

/** What the Test panel reports; the locator itself never reaches the caller. */
export interface ResolverTestResult {
  outcome: "ok" | "failed";
  message: string;
  sourceId?: string;
  host?: string;
  status?: number;
  contentType?: string;
  contentLength?: number;
}

export interface ResolverTestRuntime {
  /** Resolves references; absent when the registry is not configured. */
  sourceResolvers?: SourceResolverService | undefined;
  /** Probes a resolved location; a pinned HTTPS request by default. */
  probeLocation?: ProbeLocation | undefined;
  /** Resolves a hostname for the private-address guard; DNS by default. */
  addressLookup?: AddressLookup | undefined;
}

/**
 * Resolves a sample reference exactly as a request would and fetches its first
 * byte. The location is reported by host only, so a presigned URL never lands
 * on an admin page.
 */
export async function testResolver(
  runtime: ResolverTestRuntime,
  space: SpaceRecord,
  resolverId: string,
  reference: readonly string[],
): Promise<ResolverTestResult> {
  const resolvers = runtime.sourceResolvers;
  const probeLocation = runtime.probeLocation ?? probeOverHttps;
  if (resolvers === undefined) {
    return { outcome: "failed", message: "Resolver testing is not configured on this Control." };
  }
  const resolution = await resolvers.resolve({
    policy: space.policy,
    resolverId,
    reference,
    lifetimeSeconds: RESOLVER_TEST_LIFETIME_SECONDS,
    now: new Date(),
  });
  switch (resolution.outcome) {
    case "not_found":
      return {
        outcome: "failed",
        message:
          "The reference does not fit this resolver: wrong segment count, grammar, or value.",
      };
    case "not_allowed":
      return { outcome: "failed", message: "The location is outside the allowed source origins." };
    case "configuration_error":
      return { outcome: "failed", message: "The resolver has no usable credential." };
    case "resolved":
      break;
  }
  const host = new URL(resolution.locator).host;
  let addresses: readonly string[];
  try {
    addresses = await assertPublicHost(new URL(resolution.locator).hostname, runtime.addressLookup);
  } catch {
    return {
      outcome: "failed",
      message:
        "The location resolves to a private or loopback address, which Control will not fetch.",
      sourceId: resolution.sourceId,
      host,
    };
  }
  // The connection goes to an address the guard accepted, never to a fresh DNS answer.
  let response: LocationProbe;
  try {
    response = await probeLocation(
      resolution.locator,
      addresses[0] ?? "",
      RESOLVER_TEST_TIMEOUT_MS,
    );
  } catch {
    return {
      outcome: "failed",
      message: "The location could not be fetched within five seconds.",
      sourceId: resolution.sourceId,
      host,
    };
  }
  const result: ResolverTestResult = {
    outcome: response.status === 200 || response.status === 206 ? "ok" : "failed",
    message:
      response.status === 200 || response.status === 206
        ? "The location answered with bytes."
        : `The location answered ${response.status}.`,
    sourceId: resolution.sourceId,
    host,
    status: response.status,
  };
  const contentType = displayMediaType(response.headers.get("content-type"));
  if (contentType !== undefined) result.contentType = contentType;
  const total = /\/(\d{1,16})$/u.exec(response.headers.get("content-range") ?? "")?.[1];
  const contentLength = total ?? response.headers.get("content-length") ?? undefined;
  if (contentLength !== undefined && /^\d{1,16}$/u.test(contentLength)) {
    result.contentLength = Number(contentLength);
  }
  return result;
}
