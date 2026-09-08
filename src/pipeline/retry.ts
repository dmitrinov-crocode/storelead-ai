import { isRetryable, StepError, TimeoutError } from '../lib/errors.js';
import { sleep } from '../lib/time.js';

// Re-exported so existing call sites keep importing errors from the retry module.
export { isRetryable, StepError, TimeoutError };

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Overrides the backoff for a specific error — used to honour a `Retry-After`
   * header. Return null to fall back to the computed backoff.
   */
  delayFor?: (error: unknown, attempt: number, defaultDelayMs: number) => number | null;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injected by tests so backoff does not cost real wall-clock time. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Exponential backoff with jitter, so parallel stores do not retry in lockstep. */
export function backoffDelay(attempt: number, base: number, max: number): number {
  const exponential = Math.min(base * 2 ** (attempt - 1), max);
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 30_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) break;
      const computed = backoffDelay(attempt, base, max);
      const delay = options.delayFor?.(error, attempt, computed) ?? computed;
      options.onRetry?.(error, attempt, delay);
      await (options.sleepImpl ?? sleep)(delay);
    }
  }
  throw lastError;
}

/**
 * Caps how long a step may run. The underlying promise is not cancelled — callers
 * that own a cancellable resource (Playwright, fetch) should also honour `signal`.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(label, ms));
    }, ms);
  });

  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
