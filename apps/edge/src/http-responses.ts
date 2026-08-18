import { emitOperationalEvent } from "@shutter/protocol";
import { z } from "zod";

/**
 * A ProtocolError by contract rather than by class: the Worker may see one
 * from another copy of the protocol package, and only its name and code
 * decide the response.
 */
const protocolErrorSchema = z.object({ name: z.literal("ProtocolError"), code: z.string() });

export function protocolFailure(cause: unknown): Response {
  const protocolError = cause instanceof Error ? protocolErrorSchema.safeParse(cause) : undefined;
  if (protocolError?.success) {
    const { code } = protocolError.data;
    const status = code === "query_invalid" || code === "request_invalid" ? 400 : 403;
    return Response.json(
      { error: { code } },
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
