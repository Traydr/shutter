import { type ControlLogger, operationalErrorType } from "./logging.js";

export interface ControlShutdownDependencies {
  logger: ControlLogger;
  stopRecovery(): void;
  closeServer(): Promise<void>;
  /** Releases the runtime's connections after HTTP has drained. */
  closeRuntime(): Promise<void>;
  setExitCode(code: number): void;
  closeBudgetMs?: number;
  flushBudgetMs?: number;
}

export const CONTROL_CLOSE_BUDGET_MS = 3_000;
export const CONTROL_FLUSH_BUDGET_MS = 5_500;

type BudgetResult<T> = { status: "completed"; value: T } | { status: "timed_out" };

async function waitForBudget<T>(operation: Promise<T>, budgetMs: number): Promise<BudgetResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<BudgetResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), budgetMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      operation.then((value): BudgetResult<T> => ({ status: "completed", value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type OperationResult = { ok: true } | { ok: false; error: unknown };

function operationResult(operation: Promise<void>): Promise<OperationResult> {
  return operation.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
}

export function createControlShutdown(
  dependencies: ControlShutdownDependencies,
): () => Promise<void> {
  let shutdown: Promise<void> | undefined;

  return () => {
    shutdown ??= (async () => {
      dependencies.logger.emit("info", {
        event: "control.service.stopping",
        outcome: "accepted",
      });
      let failed = false;
      try {
        dependencies.stopRecovery();
      } catch (error) {
        failed = true;
        dependencies.logger.emit("error", {
          event: "control.service.failed",
          outcome: "failed",
          failureCode: "service_unavailable",
          errorType: operationalErrorType(error),
        });
      }

      const closeBudgetMs = dependencies.closeBudgetMs ?? CONTROL_CLOSE_BUDGET_MS;
      const close = operationResult(dependencies.closeServer());
      // The runtime's connections are released only once HTTP has drained,
      // however long that takes: an in-flight request must never find a
      // closed pool. If the drain outlives its budget the release simply
      // follows it later, and a late failure still marks the exit code.
      const release = close.then(() => operationResult(dependencies.closeRuntime()));
      const failLate = (result: Promise<OperationResult>) => {
        void result.then((outcome) => {
          if (!outcome.ok) dependencies.setExitCode(1);
        });
      };
      const failNow = (error: unknown) => {
        failed = true;
        dependencies.logger.emit("error", {
          event: "control.service.failed",
          outcome: "failed",
          failureCode: "service_unavailable",
          errorType: operationalErrorType(error),
        });
      };

      const closeWithinBudget = await waitForBudget(close, closeBudgetMs);
      if (closeWithinBudget.status === "timed_out") {
        failLate(close);
        failLate(release);
      } else {
        if (!closeWithinBudget.value.ok) failNow(closeWithinBudget.value.error);
        const releaseWithinBudget = await waitForBudget(release, closeBudgetMs);
        if (releaseWithinBudget.status === "timed_out") failLate(release);
        else if (!releaseWithinBudget.value.ok) failNow(releaseWithinBudget.value.error);
      }

      const flush = operationResult(dependencies.logger.shutdown());
      const flushWithinBudget = await waitForBudget(
        flush,
        dependencies.flushBudgetMs ?? CONTROL_FLUSH_BUDGET_MS,
      );
      if (flushWithinBudget.status === "completed" && !flushWithinBudget.value.ok) {
        failed = true;
      } else if (flushWithinBudget.status === "timed_out") {
        void flush.then((result) => {
          if (!result.ok) dependencies.setExitCode(1);
        });
      }

      if (failed) dependencies.setExitCode(1);
    })();
    return shutdown;
  };
}
