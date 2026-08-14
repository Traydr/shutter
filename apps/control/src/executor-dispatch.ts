import type { DerivativeKind } from "@shutter/protocol";

export type ExecutorWake = (kind: DerivativeKind) => Promise<void>;

export function createSerializedExecutorDispatch(wake: ExecutorWake): ExecutorWake {
  const tails = new Map<DerivativeKind, Promise<void>>();

  return (kind) => {
    const previous = tails.get(kind) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => wake(kind));
    tails.set(kind, current);

    const cleanup = () => {
      if (tails.get(kind) === current) tails.delete(kind);
    };
    void current.then(cleanup, cleanup);
    return current;
  };
}

export async function sendExecutorWake({
  baseUrl,
  fetch,
  timeoutMs,
  token,
}: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  token: string;
}): Promise<void> {
  const response = await fetch(new URL("/internal/v1/run-once", baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) {
    throw new Error(`executor wake did not complete (${response.status})`);
  }
}
