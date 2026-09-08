import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { getConfig } from '../config/index.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { createContext, type AuditContextOptions, type ViewportProfile } from './browser.js';

/**
 * One audit session per store (task 2-02).
 *
 * It owns the two contexts, applies the configured timeouts to every page, and —
 * the part that matters to the people whose shops we audit — spaces out our
 * requests so an audit never looks like a burst of traffic. Every navigation the
 * audit makes goes through `goto`/`throttle`, so the delay cannot be bypassed by
 * forgetting it in one check.
 */

export interface AuditSessionOptions {
  browser: Browser;
  /** Country whose locale/timezone the contexts present. */
  country?: string;
  /** Minimum gap between requests to the audited storefront. 0 disables it. */
  requestDelayMs?: number;
  /** Applied as both the action and the navigation timeout. */
  pageTimeoutMs?: number;
  logger?: Logger;
  contextOverrides?: AuditContextOptions['overrides'];
}

export interface GotoResult {
  response: Response | null;
  /** Navigation failures (DNS, TLS, connection refused) are findings, not crashes. */
  error: Error | null;
  durationMs: number;
}

export class AuditSession {
  readonly pageTimeoutMs: number;
  readonly requestDelayMs: number;

  private readonly browser: Browser;
  private readonly options: AuditSessionOptions;
  private readonly logger: Logger;
  private readonly limiter: RateLimiter | null;
  private readonly contexts = new Map<ViewportProfile, BrowserContext>();
  private closed = false;

  constructor(options: AuditSessionOptions) {
    const config = getConfig();
    this.browser = options.browser;
    this.options = options;
    this.logger = options.logger ?? silentLogger();
    this.pageTimeoutMs = options.pageTimeoutMs ?? config.audit.pageTimeoutMs;
    this.requestDelayMs = options.requestDelayMs ?? config.audit.requestDelayMs;
    this.limiter = this.requestDelayMs > 0 ? new RateLimiter(1000 / this.requestDelayMs) : null;
  }

  /** Contexts are created on first use, so a desktop-only check costs one context. */
  async context(profile: ViewportProfile): Promise<BrowserContext> {
    this.assertOpen();
    const existing = this.contexts.get(profile);
    if (existing) return existing;

    const context = await createContext(this.browser, profile, {
      ...(this.options.country === undefined ? {} : { country: this.options.country }),
      ...(this.options.contextOverrides === undefined
        ? {}
        : { overrides: this.options.contextOverrides }),
    });
    context.setDefaultTimeout(this.pageTimeoutMs);
    context.setDefaultNavigationTimeout(this.pageTimeoutMs);
    this.contexts.set(profile, context);
    return context;
  }

  async newPage(profile: ViewportProfile): Promise<Page> {
    const context = await this.context(profile);
    return context.newPage();
  }

  /** Blocks until the politeness delay since the previous request has elapsed. */
  async throttle(): Promise<void> {
    await this.limiter?.acquire();
  }

  /**
   * Throttled navigation that never throws: a storefront that refuses the
   * connection must still produce an audit saying so.
   */
  async goto(
    page: Page,
    url: string,
    options: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeoutMs?: number } = {},
  ): Promise<GotoResult> {
    await this.throttle();
    const startedAt = Date.now();
    try {
      const response = await page.goto(url, {
        waitUntil: options.waitUntil ?? 'domcontentloaded',
        timeout: options.timeoutMs ?? this.pageTimeoutMs,
      });
      return { response, error: null, durationMs: Date.now() - startedAt };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ url, err: err.message }, 'navigation failed');
      return { response: null, error: err, durationMs: Date.now() - startedAt };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const context of this.contexts.values()) {
      await context.close().catch(() => undefined);
    }
    this.contexts.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('AuditSession is closed');
  }
}
