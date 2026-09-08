import { RateLimiter } from '../../lib/rateLimiter.js';
import { StepError, withRetry } from '../../pipeline/retry.js';
import type { StoreLeadsDomain, StoreLeadsListResponse } from './types.js';

/**
 * StoreLeads API client (tasks 1-01 to 1-03).
 * Docs: https://storeleads.app/api — base https://storeleads.app/json/api/v1/all
 */

export const DEFAULT_BASE_URL = 'https://storeleads.app/json/api/v1/all';

/** StoreLeads caps page_size at 50. */
export const MAX_PAGE_SIZE = 50;

/**
 * Filter query-parameter names, both verified against the live API on 2026-08-28.
 *
 * Unknown filter keys are SILENTLY IGNORED rather than rejected: `f:country=PL`
 * returns 8.0M unfiltered stores with a 200, where `f:cc=PL` returns 103k Polish
 * ones. A typo here yields wrong data, not an error — see the guard in fetchStores.
 */
export const FILTER_KEYS = {
  platform: 'f:p',
  country: 'f:cc',
} as const;

export class StoreLeadsError extends StepError {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: { status?: number; retryAfterMs?: number; retryable: boolean; cause?: unknown },
  ) {
    super(message, { retryable: options.retryable, cause: options.cause });
    this.name = 'StoreLeadsError';
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface ListDomainsParams {
  /** Two-letter ISO country code, e.g. 'PL'. */
  country?: string;
  platform?: string;
  /** Prefix a field with '-' for descending order. Defaults to ascending rank. */
  sort?: string;
  page?: number;
  pageSize?: number;
  fields?: readonly string[];
}

export interface StoreLeadsClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** List operations are limited to 2 rps on Pro/Elite plans. */
  requestsPerSecond?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
}

/** Fields we actually consume; requesting only these keeps responses small. */
export const DEFAULT_FIELDS = [
  'name',
  'platform_domain',
  'merchant_name',
  'title',
  'platform',
  'country_code',
  'currency_code',
  'city',
  'rank',
  'platform_rank',
  'estimated_sales',
  'estimated_visits',
  'product_count',
  'theme',
  'apps',
  'technologies',
  'categories',
  'contact_info',
  'created_at',
  'last_updated_at',
] as const;

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export class StoreLeadsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: ((ms: number) => Promise<void>) | undefined;
  private readonly limiter: RateLimiter;

  constructor(options: StoreLeadsClientOptions) {
    if (!options.apiKey) throw new Error('StoreLeadsClient requires an apiKey');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl;
    this.limiter = new RateLimiter(options.requestsPerSecond ?? 2, {
      ...(options.nowImpl ? { now: options.nowImpl } : {}),
      ...(options.sleepImpl ? { sleep: options.sleepImpl } : {}),
    });
  }

  /** Builds the query for a domain listing (task 1-03). Exposed for testing. */
  buildListUrl(params: ListDomainsParams = {}): string {
    const url = new URL(`${this.baseUrl}/domain`);
    const pageSize = Math.min(params.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);

    if (params.country) url.searchParams.set(FILTER_KEYS.country, params.country.toUpperCase());
    if (params.platform) url.searchParams.set(FILTER_KEYS.platform, params.platform.toLowerCase());
    // Ascending rank = best stores first, which is the order the plan asks for.
    url.searchParams.set('sort', params.sort ?? 'rank');
    url.searchParams.set('page', String(params.page ?? 0));
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('fields', (params.fields ?? DEFAULT_FIELDS).join(','));

    return url.toString();
  }

  async listDomains(params: ListDomainsParams = {}): Promise<StoreLeadsListResponse> {
    return this.request<StoreLeadsListResponse>(this.buildListUrl(params));
  }

  /** `GET /domain/{domain}` returns a `{ domain: {...} }` envelope. */
  async getDomain(domain: string): Promise<StoreLeadsDomain | null> {
    const url = `${this.baseUrl}/domain/${encodeURIComponent(domain)}`;
    const response = await this.request<{ domain?: StoreLeadsDomain | null }>(url, {
      notFoundAsNull: true,
    });
    return response?.domain ?? null;
  }

  private async request<T>(url: string, options: { notFoundAsNull?: boolean } = {}): Promise<T> {
    return withRetry(
      async () => {
        await this.limiter.acquire();
        return this.performRequest<T>(url, options);
      },
      {
        attempts: this.maxRetries,
        baseDelayMs: this.retryBaseDelayMs,
        // A 429 tells us exactly how long to wait; prefer it over our backoff.
        delayFor: (error, _attempt, computed) =>
          error instanceof StoreLeadsError && error.retryAfterMs !== undefined
            ? Math.max(error.retryAfterMs, computed)
            : null,
        ...(this.sleepImpl ? { sleepImpl: this.sleepImpl } : {}),
      },
    );
  }

  private async performRequest<T>(url: string, options: { notFoundAsNull?: boolean }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      throw new StoreLeadsError(
        aborted
          ? `StoreLeads request timed out after ${this.timeoutMs}ms`
          : 'StoreLeads request failed',
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404 && options.notFoundAsNull) {
      return null as T;
    }

    if (!response.ok) {
      throw this.toError(response, await this.safeText(response));
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      // Malformed JSON from a 2xx is usually a truncated response — worth retrying.
      throw new StoreLeadsError('StoreLeads returned invalid JSON', {
        status: response.status,
        retryable: true,
        cause: error,
      });
    }
  }

  private toError(response: Response, body: string): StoreLeadsError {
    const status = response.status;
    const detail = body ? ` — ${body.slice(0, 200)}` : '';

    if (status === 401 || status === 403) {
      return new StoreLeadsError(`StoreLeads rejected the API key (${status})${detail}`, {
        status,
        retryable: false,
      });
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      return new StoreLeadsError(`StoreLeads rate limit hit (429)${detail}`, {
        status,
        retryable: true,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    if (status >= 400 && status < 500) {
      // A bad request will fail identically on every retry.
      return new StoreLeadsError(`StoreLeads request rejected (${status})${detail}`, {
        status,
        retryable: false,
      });
    }
    return new StoreLeadsError(`StoreLeads server error (${status})${detail}`, {
      status,
      retryable: true,
    });
  }

  private async safeText(response: Response): Promise<string> {
    try {
      return (await response.text()).trim();
    } catch {
      return '';
    }
  }
}
