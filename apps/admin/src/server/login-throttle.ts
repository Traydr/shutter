/**
 * A fixed-window lockout for the login form, kept in this process. The admin
 * runs as a single replica, so a Map is enough; a restart forgets the counts,
 * which only ever helps the operator.
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 5 * 60 * 1_000;

interface FailureWindow {
  count: number;
  expiresAt: number;
}

export interface LoginThrottle {
  isThrottled(key: string): boolean;
  recordFailure(key: string): void;
  clear(key: string): void;
}

export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const windows = new Map<string, FailureWindow>();

  function prune(at: number): void {
    for (const [key, entry] of windows) {
      if (entry.expiresAt <= at) windows.delete(key);
    }
  }

  return {
    isThrottled(key) {
      const entry = windows.get(key);
      return entry !== undefined && entry.expiresAt > now() && entry.count >= MAX_FAILURES;
    },
    recordFailure(key) {
      const at = now();
      prune(at);
      const entry = windows.get(key);
      if (entry === undefined || entry.expiresAt <= at) {
        windows.set(key, { count: 1, expiresAt: at + WINDOW_MS });
      } else {
        entry.count += 1;
      }
    },
    clear(key) {
      windows.delete(key);
    },
  };
}
