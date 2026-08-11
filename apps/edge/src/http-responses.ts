import { emitOperationalEvent, ProtocolError } from "@shutter/protocol";

export function protocolFailure(error: unknown): Response {
  if (
    error instanceof ProtocolError ||
    (error instanceof Error &&
      error.name === "ProtocolError" &&
      "code" in error &&
      typeof error.code === "string")
  ) {
    const status = error.code === "query_invalid" || error.code === "request_invalid" ? 400 : 403;
    return Response.json(
      { error: { code: error.code } },
      { status, headers: { "cache-control": "private, no-store" } },
    );
  }
  emitOperationalEvent("error", {
    event: "edge.failure",
    outcome: "failed",
    failureCode: "service_unavailable",
  });
  return Response.json(
    { error: { code: "service_unavailable" } },
    { status: 503, headers: { "cache-control": "private, no-store" } },
  );
}

export function notFound(): Response {
  return Response.json(
    { error: { code: "not_found" } },
    { status: 404, headers: { "cache-control": "private, no-store" } },
  );
}

export function methodNotAllowed(): Response {
  return Response.json(
    { error: { code: "method_not_allowed" } },
    {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "private, no-store" },
    },
  );
}
