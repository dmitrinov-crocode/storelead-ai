/**
 * Error types shared by the config, collectors and the pipeline.
 *
 * They live in `lib` rather than in `pipeline/retry` so that low-level modules
 * (config, clients) can mark an error as non-retryable without depending on the
 * pipeline.
 */

export class StepError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StepError';
    this.retryable = options.retryable ?? true;
  }
}

export class TimeoutError extends StepError {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`, { retryable: true });
    this.name = 'TimeoutError';
  }
}

/**
 * Any error may opt out of retrying by carrying `retryable: false`, without
 * importing StepError. `src/config` relies on this: it must stay free of
 * relative imports so `next.config.ts` can load it (see config/index.ts).
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof StepError) return error.retryable;
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    const flag = error.retryable;
    if (typeof flag === 'boolean') return flag;
  }
  // Unknown failures are assumed transient — network and browser errors dominate here.
  return true;
}
