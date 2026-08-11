export interface EdgeRefreshStatus {
  generation: number;
  refreshedAt: Date;
}

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
}
