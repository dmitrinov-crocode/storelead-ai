import type { Browser } from 'playwright';
import { getConfig } from '../config/index.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { launchBrowser } from './browser.js';
import { AuditSession, type AuditSessionOptions } from './session.js';

/**
 * Runs audits over many stores at a bounded concurrency (task 2-08).
 *
 * One Chromium process is shared; every store gets its own session — and so its
 * own contexts, cookies and storage — which is closed the moment the store is
 * done, whether it succeeded or threw. Chromium's memory grows over a long run
 * of image-heavy storefronts, so the browser is restarted after a number of
 * stores; the restart only happens while nothing is in flight.
 */

export interface AuditPoolOptions {
  concurrency?: number;
  /** Restart the browser after this many stores. 0 disables restarts. */
  restartAfter?: number;
  /** Injected by tests; defaults to launching Chromium. */
  launch?: () => Promise<Browser>;
  logger?: Logger;
  /** Passed through to every session. */
  session?: Omit<AuditSessionOptions, 'browser' | 'logger'>;
}

export type PoolResult<R> =
  { ok: true; value: R; error: null } | { ok: false; value: null; error: Error };

export class AuditPool {
  readonly concurrency: number;
  readonly restartAfter: number;

  /**
   * The launch *promise*, not the browser: two workers starting at once must
   * share one Chromium. Memoising the resolved value instead would launch a
   * second browser and orphan the first, which then keeps the process alive.
   */
  private browserPromise: Promise<Browser> | null = null;
  private readonly launch: () => Promise<Browser>;
  private readonly logger: Logger;
  private active = 0;
  private sinceRestart = 0;
  private restarts = 0;

  constructor(private readonly options: AuditPoolOptions = {}) {
    const config = getConfig();
    this.concurrency = Math.max(1, options.concurrency ?? config.pipeline.storeConcurrency);
    this.restartAfter = options.restartAfter ?? 25;
    this.launch = options.launch ?? (() => launchBrowser());
    this.logger = options.logger ?? silentLogger();
  }

  /** Current browser, launched on first use. Exposed for tests and diagnostics. */
  currentBrowser(): Promise<Browser> {
    this.browserPromise ??= this.launch();
    return this.browserPromise;
  }

  get restartCount(): number {
    return this.restarts;
  }

  /**
   * Runs `worker` for each item with at most `concurrency` sessions open.
   * A worker that throws fails only its own item.
   */
  async map<T, R>(
    items: readonly T[],
    worker: (item: T, session: AuditSession, index: number) => Promise<R>,
  ): Promise<PoolResult<R>[]> {
    return mapWithConcurrency(items, this.concurrency, async (item, index) => {
      const session = await this.acquire();
      try {
        const value = await worker(item, session, index);
        return { ok: true, value, error: null } satisfies PoolResult<R>;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn({ index, err: err.message }, 'audit worker failed');
        return { ok: false, value: null, error: err } satisfies PoolResult<R>;
      } finally {
        await this.release(session);
      }
    });
  }

  async close(): Promise<void> {
    const pending = this.browserPromise;
    this.browserPromise = null;
    if (!pending) return;
    const browser = await pending.catch(() => null);
    await browser?.close().catch(() => undefined);
  }

  private async acquire(): Promise<AuditSession> {
    // Only safe while idle: closing the browser would kill live contexts.
    if (this.active === 0 && this.restartAfter > 0 && this.sinceRestart >= this.restartAfter) {
      await this.restart();
    }
    const browser = await this.currentBrowser();
    this.active += 1;
    return new AuditSession({ ...this.options.session, browser, logger: this.logger });
  }

  private async release(session: AuditSession): Promise<void> {
    await session.close();
    this.active -= 1;
    this.sinceRestart += 1;
  }

  private async restart(): Promise<void> {
    this.logger.info({ afterStores: this.sinceRestart }, 'restarting the audit browser');
    await this.close();
    this.sinceRestart = 0;
    this.restarts += 1;
  }
}
