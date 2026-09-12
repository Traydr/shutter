import { AdminApiError } from "@shutter/admin-api";

/**
 * A failed Control call as a server function may return it: plain data, so
 * it crosses the client boundary intact and the page can show `detail`.
 */
export interface ControlFailure {
  status: number | undefined;
  code: string;
  detail: string | undefined;
  requestId: string | undefined;
}

export type ControlResult<T> = { ok: true; value: T } | { ok: false; failure: ControlFailure };

export function failureOf(error: AdminApiError): ControlFailure {
  return {
    status: error.status,
    code: error.code,
    detail: error.detail ?? (error.code === "transport" ? error.message : undefined),
    requestId: error.requestId,
  };
}

/** Runs one Control call and folds its outcome into a result; anything but an API error rethrows. */
export async function controlResult<T>(work: () => Promise<T>): Promise<ControlResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof AdminApiError) return { ok: false, failure: failureOf(error) };
    throw error;
  }
}

/** One sentence for a failure, for a notice or an error page. */
export function describeFailure(failure: ControlFailure): string {
  if (failure.detail !== undefined) return failure.detail;
  switch (failure.code) {
    case "unauthorized":
      return "Control rejected the admin credential. Check CONTROL_ADMIN_TOKEN.";
    case "not_found":
      return "That record does not exist.";
    case "conflict":
      return "That identifier is already taken.";
    case "service_unavailable":
      return "The Space Registry is unavailable.";
    case "transport":
      return "Control could not be reached.";
    default:
      return `Control answered ${failure.status ?? "with an error"} (${failure.code}).`;
  }
}

/** One sentence for a call that never produced a result: the request itself failed. */
export function describeThrown(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? `The request failed: ${cause.message}`
    : "The request could not be sent.";
}
