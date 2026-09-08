/**
 * Spend control for the PageSpeed API (task 2-20).
 *
 * Two different failures are handled here, and only the second one is about the
 * API's own quota:
 *
 *   - **Our budget.** A run may not make more than N requests. This is a
 *     stop-loss against `--force` over a large batch, not an API limit.
 *   - **Their quota.** Once Google answers "quota exceeded", every later request
 *     in the run gets the same answer. Without a latch each remaining store would
 *     spend its full retry ladder — three attempts, seconds of backoff each — to
 *     rediscover that. The latch trips once and the rest of the run skips
 *     PageSpeed immediately.
 *
 * The latch lives for the run, in memory: quotas reset on Google's clock, not
 * ours, so persisting the trip would keep us locked out longer than the API does.
 */

export type QuotaState = 'ok' | 'budget-exhausted' | 'quota-exhausted';

export class PagespeedQuota {
  private readonly maxRequests: number;
  private spent = 0;
  private tripped = false;

  constructor(options: { maxRequests: number }) {
    if (options.maxRequests <= 0) throw new Error('maxRequests must be > 0');
    this.maxRequests = options.maxRequests;
  }

  get state(): QuotaState {
    if (this.tripped) return 'quota-exhausted';
    return this.spent >= this.maxRequests ? 'budget-exhausted' : 'ok';
  }

  get remaining(): number {
    return this.tripped ? 0 : Math.max(0, this.maxRequests - this.spent);
  }

  get used(): number {
    return this.spent;
  }

  /** Human-readable reason for a skip, or null while requests are still allowed. */
  get reason(): string | null {
    switch (this.state) {
      case 'quota-exhausted':
        return 'PageSpeed API quota exhausted earlier in this run';
      case 'budget-exhausted':
        return `PageSpeed request budget spent (${this.maxRequests} per run)`;
      case 'ok':
        return null;
    }
  }

  /** Claims one request. False means the caller must skip rather than call. */
  reserve(): boolean {
    if (this.state !== 'ok') return false;
    this.spent += 1;
    return true;
  }

  /** Called after the client has exhausted its retries on a quota error. */
  trip(): void {
    this.tripped = true;
  }
}
