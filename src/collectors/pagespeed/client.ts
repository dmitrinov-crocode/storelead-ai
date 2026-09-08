import { RateLimiter } from '../../lib/rateLimiter.js';
import { StepError, withRetry } from '../../pipeline/retry.js';
import { extractMetrics, type PagespeedMetrics } from './metrics.js';
import { CATEGORIES, STRATEGIES } from './types.js';
import type { GoogleApiError, PagespeedResponse, PagespeedStrategy } from './types.js';

/**
 * Google PageSpeed Insights v5 client (task 2-19).
 * Docs: https://developers.google.com/speed/docs/insights/v5/get-started
 *
 * An API key is required. The documentation calls it optional, and this project
 * believed that too, but a keyless call on 2026-09-01 answered 429 with
 * `quota_limit_value: "0"` — the anonymous per-day quota is now zero, twice in a
 * row, for two different URLs. So the key is mandatory in practice; the client
 * still accepts an empty one so a caller can prove that for itself.
 */

export const DEFAULT_BASE_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/**
 * One analysis runs a real Lighthouse pass on Google's hardware and regularly
 * takes 30–60 s on a slow store. A 30 s timeout would abort healthy runs.
 */
export const DEFAULT_TIMEOUT_MS = 90_000;

export class PagespeedError extends StepError {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  /**
   * Lighthouse's own failure code, dug out of the message of a 400/500 —
   * ERRORED_DOCUMENT_REQUEST, DNS_FAILURE, NO_FCP… This is a fact about the
   * store, not about our request, so the caller records it instead of retrying.
   */
  readonly lighthouseErrorCode: string | undefined;
  /**
   * The API refused for lack of quota. Every later request in the run would get
   * the same answer, so the caller stops asking rather than retrying per store
   * (task 2-20).
   */
  readonly quotaExceeded: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      lighthouseErrorCode?: string;
      quotaExceeded?: boolean;
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { retryable: options.retryable, cause: options.cause });
    this.name = 'PagespeedError';
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.lighthouseErrorCode = options.lighthouseErrorCode;
    this.quotaExceeded = options.quotaExceeded ?? false;
  }
}

export interface PagespeedClientOptions {
  /** Optional in the type only — see the note above. */
  apiKey?: string | undefined;
  baseUrl?: string;
  /**
   * Default quota with a key is 240 queries/minute (4 rps). One request per
   * second leaves room for the audit step, which shares nothing but our egress.
   */
  requestsPerSecond?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Lighthouse locale; affects only human-readable strings, not the numbers. */
  locale?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
}

export interface PagespeedRunResult {
  metrics: PagespeedMetrics;
  /** The untouched response, for `pagespeed_results.raw_json`. */
  raw: PagespeedResponse;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * A quota failure arrives as 429, but older PSI deployments answer 403 with the
 * same `rateLimitExceeded` reason, and a 403 for a bad key must not be retried
 * for the rest of the run. The reason string, not the status, decides.
 */
function isQuotaError(error: GoogleApiError | undefined): boolean {
  const reasons = [
    ...(error?.errors ?? []).map((e) => e.reason ?? ''),
    error?.status ?? '',
    error?.message ?? '',
  ].join(' ');
  return /rateLimit|quota|RESOURCE_EXHAUSTED/i.test(reasons);
}

/** PSI reports an unloadable page as `Lighthouse returned error: ERRORED_DOCUMENT_REQUEST`. */
function parseLighthouseErrorCode(message: string | undefined): string | undefined {
  const match = /Lighthouse returned error:\s*([A-Z_]+)/.exec(message ?? '');
  return match?.[1];
}

export class PagespeedClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly locale: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: ((ms: number) => Promise<void>) | undefined;
  private readonly limiter: RateLimiter;

  constructor(options: PagespeedClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 3;
    // Quota resets are measured in seconds, not milliseconds: start the backoff high.
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 5_000;
    this.locale = options.locale;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl;
    this.limiter = new RateLimiter(options.requestsPerSecond ?? 1, {
      ...(options.nowImpl ? { now: options.nowImpl } : {}),
      ...(options.sleepImpl ? { sleep: options.sleepImpl } : {}),
    });
  }

  /** Exposed for testing: the exact query a run will send. */
  buildUrl(target: string, strategy: PagespeedStrategy): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set('url', target);
    url.searchParams.set('strategy', strategy);
    // Repeated `category` params; omitting them returns performance only.
    for (const category of CATEGORIES) url.searchParams.append('category', category);
    if (this.locale) url.searchParams.set('locale', this.locale);
    if (this.apiKey) url.searchParams.set('key', this.apiKey);
    return url.toString();
  }

  async run(target: string, strategy: PagespeedStrategy): Promise<PagespeedRunResult> {
    const raw = await this.request(this.buildUrl(target, strategy));
    return { metrics: extractMetrics(raw, strategy), raw };
  }

  /**
   * Both strategies for one URL. They run one after the other rather than in
   * parallel: they share a single quota, and a store that fails on mobile will
   * fail on desktop too — better to spend one request finding that out.
   */
  async runBoth(target: string): Promise<PagespeedRunResult[]> {
    const results: PagespeedRunResult[] = [];
    for (const strategy of STRATEGIES) {
      results.push(await this.run(target, strategy));
    }
    return results;
  }

  private async request(url: string): Promise<PagespeedResponse> {
    return withRetry(
      async () => {
        await this.limiter.acquire();
        return this.performRequest(url);
      },
      {
        attempts: this.maxRetries,
        baseDelayMs: this.retryBaseDelayMs,
        delayFor: (error, _attempt, computed) =>
          error instanceof PagespeedError && error.retryAfterMs !== undefined
            ? Math.max(error.retryAfterMs, computed)
            : null,
        ...(this.sleepImpl ? { sleepImpl: this.sleepImpl } : {}),
      },
    );
  }

  private async performRequest(url: string): Promise<PagespeedResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      throw new PagespeedError(
        aborted
          ? `PageSpeed request timed out after ${this.timeoutMs}ms`
          : 'PageSpeed request failed',
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    const body = await this.safeJson(response);

    if (!response.ok) {
      throw this.toError(response, body?.error);
    }
    if (!body) {
      // Malformed JSON from a 2xx is usually a truncated response.
      throw new PagespeedError('PageSpeed returned invalid JSON', {
        status: response.status,
        retryable: true,
      });
    }
    return body;
  }

  private toError(response: Response, error: GoogleApiError | undefined): PagespeedError {
    const status = response.status;
    const detail = error?.message ? ` — ${error.message.slice(0, 300)}` : '';
    const lighthouseErrorCode = parseLighthouseErrorCode(error?.message);

    if (status === 429 || isQuotaError(error)) {
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      return new PagespeedError(`PageSpeed quota exceeded (${status})${detail}`, {
        status,
        retryable: true,
        quotaExceeded: true,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    if (lighthouseErrorCode) {
      // The store did not load. Retrying spends quota on the same answer.
      return new PagespeedError(`PageSpeed could not analyse the page (${status})${detail}`, {
        status,
        retryable: false,
        lighthouseErrorCode,
      });
    }
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      return new PagespeedError(`PageSpeed rejected the request (${status})${detail}`, {
        status,
        retryable: false,
      });
    }
    return new PagespeedError(`PageSpeed server error (${status})${detail}`, {
      status,
      retryable: true,
    });
  }

  private async safeJson(response: Response): Promise<PagespeedResponse | undefined> {
    try {
      return (await response.json()) as PagespeedResponse;
    } catch {
      return undefined;
    }
  }
}
