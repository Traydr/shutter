import type { EdgeRefreshReportDirective } from "@shutter/protocol";

export interface EdgeRefreshStatus {
  generation: number;
  refreshedAt: Date;
}

/**
 * How long a report stays fresh enough that Control does not ask the Edge for
 * another one. An Edge isolate that already serves a snapshot names its
 * generation on every snapshot read, which refreshes the status for free; this
 * bounds how stale `refreshedAt` gets when only fresh isolates read.
 */
export const EDGE_REPORT_LIVENESS_MS = 5 * 60_000;

export class EdgeRefreshTracker {
  #latest: EdgeRefreshStatus | undefined;
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  report(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) return;
    if (this.#latest !== undefined && generation < this.#latest.generation) return;
    this.#latest = { generation, refreshedAt: this.#now() };
  }

  latest(): EdgeRefreshStatus | undefined {
    return this.#latest === undefined
      ? undefined
      : { generation: this.#latest.generation, refreshedAt: new Date(this.#latest.refreshedAt) };
  }

  /**
   * Whether Control wants the Edge to report applying `generation`: when it
   * has no report yet, an older one, or none within the liveness window.
   * Otherwise the snapshot read already told Control everything a report would.
   */
  directiveFor(generation: number): EdgeRefreshReportDirective {
    const latest = this.#latest;
    if (latest === undefined || latest.generation < generation) return "wanted";

    return this.#now().getTime() - latest.refreshedAt.getTime() >= EDGE_REPORT_LIVENESS_MS
      ? "wanted"
      : "current";
  }
}
