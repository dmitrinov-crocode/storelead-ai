import { withTimeout } from '../pipeline/retry.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { elapsedMs } from '../lib/time.js';
import { createIssue, type Issue } from './issues.js';
import type { GotoResult } from './session.js';

/**
 * Resilience for the audit (task 2-06).
 *
 * A storefront that breaks one check must still yield the other twenty. Every
 * check runs isolated: a throw becomes a recorded failure, the audit continues
 * and the run ends PARTIAL instead of losing everything that did work.
 */

export interface CheckOutcome {
  name: string;
  status: 'ok' | 'failed';
  issues: Issue[];
  error: string | null;
  durationMs: number;
}

export interface RunCheckOptions {
  logger?: Logger;
  /** Hard cap for a check that hangs past Playwright's own timeouts. */
  timeoutMs?: number;
}

export async function runCheck(
  name: string,
  fn: () => Promise<Issue[] | void>,
  options: RunCheckOptions = {},
): Promise<CheckOutcome> {
  const startedAt = performance.now();
  try {
    const issues = options.timeoutMs
      ? await withTimeout(() => Promise.resolve(fn()), options.timeoutMs, `check ${name}`)
      : await fn();
    return {
      name,
      status: 'ok',
      issues: issues ?? [],
      error: null,
      durationMs: elapsedMs(startedAt),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.logger ?? silentLogger()).warn({ check: name, err: message }, 'audit check failed');
    return { name, status: 'failed', issues: [], error: message, durationMs: elapsedMs(startedAt) };
  }
}

/** Accumulates the outcomes of one page's checks. */
export class CheckSuite {
  readonly outcomes: CheckOutcome[] = [];

  constructor(private readonly options: RunCheckOptions = {}) {}

  async run(name: string, fn: () => Promise<Issue[] | void>): Promise<CheckOutcome> {
    const outcome = await runCheck(name, fn, this.options);
    this.outcomes.push(outcome);
    return outcome;
  }

  get issues(): Issue[] {
    return this.outcomes.flatMap((o) => o.issues);
  }

  get failed(): CheckOutcome[] {
    return this.outcomes.filter((o) => o.status === 'failed');
  }

  /** True when some checks ran and some did not — the result is incomplete. */
  get partial(): boolean {
    return this.failed.length > 0;
  }
}

/** Why a page could not be audited, or that it could. */
export type PageAvailability = 'ok' | 'timeout' | 'unreachable' | 'http_error';

export interface NavigationVerdict {
  availability: PageAvailability;
  httpStatus: number | null;
  /** Present unless the page loaded fine; the audit records it and moves on. */
  issue: Issue | null;
}

const TIMEOUT_PATTERN = /Timeout \d+ms exceeded/i;

/**
 * Turns the outcome of a navigation into a verdict.
 *
 * A shop that does not open is the single most valuable finding in the whole
 * audit, so it gets a first-class status rather than surfacing as a crash.
 */
export function classifyNavigation(
  result: GotoResult,
  context: { page: Issue['page']; url: string },
): NavigationVerdict {
  if (result.error) {
    const timedOut = TIMEOUT_PATTERN.test(result.error.message);
    return {
      availability: timedOut ? 'timeout' : 'unreachable',
      httpStatus: null,
      issue: createIssue({
        page: context.page,
        category: 'technical',
        severity: 'CRITICAL',
        title: timedOut ? 'Page did not finish loading' : 'Page could not be opened',
        detail: result.error.message,
        evidence: {
          url: context.url,
          text: result.error.message,
          actual: `${result.durationMs}ms elapsed`,
        },
      }),
    };
  }

  const status = result.response?.status() ?? null;
  if (status === null) {
    return {
      availability: 'unreachable',
      httpStatus: null,
      issue: createIssue({
        page: context.page,
        category: 'technical',
        severity: 'CRITICAL',
        title: 'Page could not be opened',
        detail: 'The browser returned no response for this URL',
        evidence: { url: context.url },
      }),
    };
  }

  if (status >= 400) {
    return {
      availability: 'http_error',
      httpStatus: status,
      issue: createIssue({
        page: context.page,
        category: 'technical',
        severity: status >= 500 ? 'CRITICAL' : 'MAJOR',
        title: `Page returns HTTP ${status}`,
        evidence: { url: context.url, status, expected: '200', actual: String(status) },
      }),
    };
  }

  return { availability: 'ok', httpStatus: status, issue: null };
}
