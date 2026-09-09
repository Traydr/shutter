import { ProtocolError } from "./errors.js";
import { normalizeOptimizationQuery, type OptimizationPolicyInput } from "./normalization.js";
import type { PreviewKind } from "./types.js";

/**
 * The operation a v2 Delivery URL selects with its query. No query is Source
 * Delivery; `w` (and `q`) is Image Optimization of the original; `preview`
 * with `w` is Image Optimization of the stored Master Preview.
 */
export type DeliveryOperation =
  | { type: "source_delivery" }
  | { type: "image_optimization"; width: number; quality: number; isCanonical: boolean }
  | {
      type: "master_preview";
      kind: PreviewKind;
      width: number;
      quality: number;
      isCanonical: boolean;
    };

export interface DeliveryQuery {
  operation: DeliveryOperation;
  /** Present only when the route accepts a token and the query carried one. */
  token?: string;
}

/** A private Space's query: the token is proven present, so the gate need not re-check. */
export interface PrivateDeliveryQuery extends DeliveryQuery {
  token: string;
}

export interface DeliveryQueryOptions {
  /** A private Space requires `token`; a public Space rejects it as unknown. */
  token: "required" | "forbidden";
}

const OPERATION_PARAMETERS = new Set(["w", "q", "preview"]);

function single(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  if (values.length > 1) {
    throw new ProtocolError("query_invalid", `${name} may appear at most once`);
  }
  return values[0];
}

/**
 * Parses a v2 delivery query into its operation. Unknown or duplicated
 * parameters, `q` or `preview` without `w`, and an unknown preview kind are
 * `query_invalid`. A missing required token is `capability_malformed` so the
 * route answers 403 like any other failed authorization.
 */
export function parseDeliveryQuery(
  query: URLSearchParams,
  policy: OptimizationPolicyInput,
  options: { token: "required" },
): PrivateDeliveryQuery;
export function parseDeliveryQuery(
  query: URLSearchParams,
  policy: OptimizationPolicyInput,
  options: DeliveryQueryOptions,
): DeliveryQuery;
export function parseDeliveryQuery(
  query: URLSearchParams,
  policy: OptimizationPolicyInput,
  options: DeliveryQueryOptions,
): DeliveryQuery {
  for (const key of query.keys()) {
    if (OPERATION_PARAMETERS.has(key)) continue;
    if (key === "token" && options.token === "required") continue;
    throw new ProtocolError("query_invalid", `unknown delivery parameter: ${key}`);
  }
  const token = options.token === "required" ? single(query, "token") : undefined;
  if (options.token === "required" && (token === undefined || token.length === 0)) {
    throw new ProtocolError("capability_malformed", "a private Delivery URL requires a token");
  }
  const result: DeliveryQuery = { operation: parseOperation(query, policy) };
  if (token !== undefined) result.token = token;
  return result;
}

function parseOperation(
  query: URLSearchParams,
  policy: OptimizationPolicyInput,
): DeliveryOperation {
  const preview = single(query, "preview");
  const hasWidth = query.has("w");
  if (!hasWidth) {
    if (query.has("q")) throw new ProtocolError("query_invalid", "q requires w");
    if (preview !== undefined) throw new ProtocolError("query_invalid", "preview requires w");
    return { type: "source_delivery" };
  }
  const optimization = new URLSearchParams();
  for (const [key, value] of query) {
    if (key === "w" || key === "q") optimization.append(key, value);
  }
  const normalized = normalizeOptimizationQuery(optimization, policy);
  if (preview === undefined) return { type: "image_optimization", ...normalized };
  if (preview !== "video" && preview !== "pdf") {
    throw new ProtocolError("query_invalid", "preview must be video or pdf");
  }
  return { type: "master_preview", kind: preview, ...normalized };
}

/**
 * The canonical query for an operation, in the contract's order: `preview`,
 * then `w`, then `q`. Source Delivery has none.
 */
export function canonicalDeliveryQuery(operation: DeliveryOperation): string {
  switch (operation.type) {
    case "source_delivery":
      return "";
    case "image_optimization":
      return `w=${operation.width}&q=${operation.quality}`;
    case "master_preview":
      return `preview=${operation.kind}&w=${operation.width}&q=${operation.quality}`;
  }
}
