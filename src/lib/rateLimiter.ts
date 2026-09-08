import { sleep as realSleep } from './time.js';

/**
 * Spaces outgoing requests so a shared API quota is never exceeded (task 1-02).
 * StoreLeads allows 2 list requests/second on Pro and Elite plans.
 *
 * Calls are serialised through a promise chain, so concurrent callers queue in
 * arrival order rather than all firing at once.
 */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    requestsPerSecond: number,
    options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    if (requestsPerSecond <= 0) throw new Error('requestsPerSecond must be > 0');
    this.minIntervalMs = 1000 / requestsPerSecond;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? realSleep;
  }

  /** Resolves when the caller is allowed to make its request. */
  acquire(): Promise<void> {
    const wait = this.queue.then(async () => {
      const elapsed = this.now() - this.lastStart;
      const remaining = this.minIntervalMs - elapsed;
      if (remaining > 0) await this.sleep(remaining);
      this.lastStart = this.now();
    });
    // Keep the chain alive even if a caller rejects downstream.
    this.queue = wait.catch(() => undefined);
    return wait;
  }
}
