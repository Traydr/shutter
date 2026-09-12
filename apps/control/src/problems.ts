/**
 * RFC 9457 problem responses for the v2 and admin JSON endpoints. `code` is the member
 * clients branch on; `type` derives from it. Nothing else about the request
 * enters the body (docs/contracts/v2/errors.md).
 */

export const PROBLEM_TYPE_BASE = "https://shutter.traydr.dev/problems/";

export type ProblemCode =
  | "unauthorized"
  | "not_found"
  | "request_invalid"
  | "service_unavailable"
  | "configuration_error"
  | "internal_invariant"
  | "conflict"
  | "payload_too_large";

const PROBLEM_STATUS = {
  unauthorized: 401,
  not_found: 404,
  request_invalid: 400,
  service_unavailable: 503,
  configuration_error: 503,
  internal_invariant: 409,
  conflict: 409,
  payload_too_large: 413,
} as const satisfies Record<ProblemCode, number>;

const REASON_PHRASE = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  409: "Conflict",
  413: "Content Too Large",
  503: "Service Unavailable",
} as const satisfies Record<(typeof PROBLEM_STATUS)[ProblemCode], string>;

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  /**
   * Which input was rejected, in the registry's own words. Only the admin
   * routes set it: their caller is an operator who has to fix the input, and
   * the registry's messages name no secret, locator, or upstream response.
   */
  detail?: string;
  requestId?: string;
}

export function problemDetails(
  code: ProblemCode,
  requestId?: string,
  detail?: string,
): ProblemDetails {
  const status = PROBLEM_STATUS[code];
  const details: ProblemDetails = {
    type: `${PROBLEM_TYPE_BASE}${code}`,
    title: REASON_PHRASE[status],
    status,
    code,
  };
  if (detail !== undefined) details.detail = detail;
  if (requestId !== undefined) details.requestId = requestId;
  return details;
}

export function problemResponse(code: ProblemCode, requestId?: string, detail?: string): Response {
  const details = problemDetails(code, requestId, detail);
  const headers = new Headers({
    "content-type": "application/problem+json",
    "cache-control": "private, no-store",
  });
  if (code === "unauthorized") headers.set("www-authenticate", "Bearer");
  return new Response(JSON.stringify(details), { status: details.status, headers });
}
