import { SHUTTER_PLACEHOLDER_WIDTH, SHUTTER_WIDTHS } from "./constants.js";
import { ProtocolError } from "./errors.js";

export interface OptimizationPolicyInput {
  qualities: readonly number[];
  defaultQuality: number;
}

export interface NormalizedOptimizationQuery {
  width: number;
  quality: number;
  isCanonical: boolean;
}

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

function parsePositiveInteger(value: string, name: string): number {
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new ProtocolError("query_invalid", `${name} must be a positive base-10 integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProtocolError("query_invalid", `${name} is outside the supported integer range`);
  }
  return parsed;
}

export function normalizeWidth(requestedWidth: number): number {
  if (!Number.isSafeInteger(requestedWidth) || requestedWidth <= 0) {
    throw new ProtocolError("query_invalid", "width must be a positive integer");
  }
  if (requestedWidth === SHUTTER_PLACEHOLDER_WIDTH) return SHUTTER_PLACEHOLDER_WIDTH;
  return SHUTTER_WIDTHS.find((width) => width >= requestedWidth) ?? SHUTTER_WIDTHS[12];
}

export function normalizeQuality(requestedQuality: number, permitted: readonly number[]): number {
  if (!Number.isSafeInteger(requestedQuality) || requestedQuality <= 0 || permitted.length === 0) {
    throw new ProtocolError(
      "query_invalid",
      "quality policy and request must contain positive integers",
    );
  }

  return [...permitted]
    .sort((left, right) => left - right)
    .reduce((closest, candidate) => {
      const candidateDistance = Math.abs(candidate - requestedQuality);
      const closestDistance = Math.abs(closest - requestedQuality);
      return candidateDistance < closestDistance ||
        (candidateDistance === closestDistance && candidate > closest)
        ? candidate
        : closest;
    });
}

export function normalizeOptimizationQuery(
  query: URLSearchParams,
  policy: OptimizationPolicyInput,
): NormalizedOptimizationQuery {
  for (const key of query.keys()) {
    if (key !== "w" && key !== "q") {
      throw new ProtocolError("query_invalid", `unknown optimization parameter: ${key}`);
    }
  }
  if (query.getAll("w").length !== 1 || query.getAll("q").length > 1) {
    throw new ProtocolError(
      "query_invalid",
      "width is required once and quality may appear at most once",
    );
  }

  const widthValue = query.get("w");
  if (widthValue === null) throw new ProtocolError("query_invalid", "width is required");
  if (!policy.qualities.includes(policy.defaultQuality)) {
    throw new ProtocolError("query_invalid", "default quality must be permitted by the Space");
  }

  const requestedWidth = parsePositiveInteger(widthValue, "width");
  const qualityValue = query.get("q");
  const requestedQuality =
    qualityValue === null ? policy.defaultQuality : parsePositiveInteger(qualityValue, "quality");
  const width = normalizeWidth(requestedWidth);
  const quality = normalizeQuality(requestedQuality, policy.qualities);

  return {
    width,
    quality,
    isCanonical:
      widthValue === String(width) && qualityValue !== null && qualityValue === String(quality),
  };
}
