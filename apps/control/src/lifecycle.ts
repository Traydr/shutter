import { type ControlLogger, operationalErrorType } from "./logging.js";

export interface ControlShutdownDependencies {
  logger: ControlLogger;
  stopRecovery(): void;
  closeServer(): Promise<void>;
  setExitCode(code: number): void;
  timeoutMs?: number;
}

async function withinTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("control shutdown timed out")), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createControlShutdown(
  dependencies: ControlShutdownDependencies,
): () => Promise<void> {
  let shutdown: Promise<void> | undefined;

  return () => {
    shutdown ??= withinTimeout(
      (async () => {
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
        try {
          await dependencies.closeServer();
        } catch (error) {
          failed = true;
          dependencies.logger.emit("error", {
            event: "control.service.failed",
            outcome: "failed",
            failureCode: "service_unavailable",
            errorType: operationalErrorType(error),
          });
        }
        try {
          await dependencies.logger.shutdown();
        } catch {
          failed = true;
        }
        if (failed) dependencies.setExitCode(1);
      })(),
      dependencies.timeoutMs ?? 8_000,
    ).catch(() => dependencies.setExitCode(1));
    return shutdown;
  };
}
