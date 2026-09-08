import { getConfig } from '../../config/index.js';
import { listPagespeedResults, savePagespeedResult } from '../../db/repositories/storeFacts.js';
import { staleStrategies } from '../../collectors/pagespeed/cache.js';
import { PagespeedClient, PagespeedError } from '../../collectors/pagespeed/client.js';
import type { PagespeedRunResult } from '../../collectors/pagespeed/client.js';
import { PagespeedQuota } from '../../collectors/pagespeed/quota.js';
import { STRATEGIES } from '../../collectors/pagespeed/types.js';
import type { PagespeedStrategy } from '../../collectors/pagespeed/types.js';
import { StepError } from '../retry.js';
import type { PipelineStep } from '../types.js';

/**
 * The PageSpeed step (task 2-20).
 *
 * Its whole job is deciding what *not* to request. Three gates, in order:
 *
 *   1. **Cache.** A stored result younger than the TTL is reused, including a
 *      result that recorded a failure — see `collectors/pagespeed/cache.ts`.
 *   2. **Budget.** One run may spend only so many requests.
 *   3. **Quota latch.** The first "quota exceeded" from Google skips PageSpeed
 *      for every remaining store instead of retrying it store by store.
 *
 * A store that cannot be analysed at all is still written, with null metrics and
 * the reason in `raw_json`: that row is what stops us asking again tomorrow.
 */

/** Only the part of the client this step needs, so tests can supply a stub. */
export interface PagespeedSource {
  run(url: string, strategy: PagespeedStrategy): Promise<PagespeedRunResult>;
}

export interface PagespeedStepOptions {
  client?: PagespeedSource;
  /** Defaults to PAGESPEED_API_KEY. Without one the step skips rather than fails. */
  apiKey?: string | undefined;
  /** Defaults to PAGESPEED_CACHE_DAYS. */
  cacheDays?: number;
  /** Defaults to PAGESPEED_MAX_REQUESTS_PER_RUN. */
  maxRequestsPerRun?: number;
  /** Shared across stores; created per step instance when omitted. */
  quota?: PagespeedQuota;
  now?: () => Date;
  timeoutMs?: number;
}

export interface PagespeedStepMeta {
  fetched: PagespeedStrategy[];
  cached: PagespeedStrategy[];
  unanalysable: { strategy: PagespeedStrategy; code: string }[];
  skipped: { strategy: PagespeedStrategy; reason: string }[];
  quotaUsed: number;
}

export function createPagespeedStep(options: PagespeedStepOptions = {}): PipelineStep {
  const cacheDays = options.cacheDays ?? getConfig().pagespeed.cacheDays;
  const now = options.now ?? (() => new Date());
  const quota =
    options.quota ??
    new PagespeedQuota({
      maxRequests: options.maxRequestsPerRun ?? getConfig().pagespeed.maxRequestsPerRun,
    });

  let client: PagespeedSource | undefined = options.client;
  /**
   * Null when no API key is configured. A missing key is our problem, not the
   * store's, so the step skips instead of throwing — throwing would mark every
   * store FAILED for a line missing from `.env`. Built on first use, so a run
   * that never reaches this step never asks for the key.
   */
  const getClient = (): PagespeedSource | null => {
    if (client) return client;
    const apiKey = 'apiKey' in options ? options.apiKey : getConfig().pagespeed.apiKey;
    if (!apiKey) return null;
    client = new PagespeedClient({ apiKey });
    return client;
  };

  return {
    name: 'pagespeed',
    scope: 'store',
    // Missing performance data is a gap in the report, not a reason to drop a lead.
    softFail: true,
    attempts: 1,
    /**
     * Sized from what the client can actually spend: two strategies, each up to
     * three attempts of a 90 s request with backoff in between. 240 s was too
     * tight — formeds.pl finished both analyses and saved both rows, and the
     * step was still marked FAILED because the budget ran out first (task 2-24).
     */
    timeoutMs: options.timeoutMs ?? 600_000,

    isSatisfied: (ctx) => {
      if (!ctx.store) return false;
      const rows = listPagespeedResults(ctx.store.id, ctx.db);
      return staleStrategies(rows, cacheDays, now()).length === 0;
    },

    run: async (ctx) => {
      const store = ctx.store;
      if (!store) throw new StepError('pagespeed is a store-scoped step', { retryable: false });

      const rows = listPagespeedResults(store.id, ctx.db);
      // `--force` re-measures both strategies; otherwise only what has aged out.
      const wanted = ctx.force ? [...STRATEGIES] : staleStrategies(rows, cacheDays, now());
      const cached = STRATEGIES.filter((s) => !wanted.includes(s));

      const meta: PagespeedStepMeta = {
        fetched: [],
        cached,
        unanalysable: [],
        skipped: [],
        quotaUsed: 0,
      };

      // Everything is cached and inside the TTL: the cheapest outcome there is.
      if (wanted.length === 0) return { status: 'SKIPPED', meta };

      const source = getClient();
      if (!source) {
        const reason = 'PAGESPEED_API_KEY is not set';
        ctx.logger.warn({ store: store.domain }, `pagespeed skipped: ${reason}`);
        return {
          status: 'SKIPPED',
          meta: { ...meta, skipped: wanted.map((strategy) => ({ strategy, reason })) },
        };
      }

      for (const strategy of wanted) {
        // The orchestrator aborts the signal when the step's budget is spent.
        // Stopping here returns the strategies already measured and saved,
        // instead of letting the outer timeout throw away completed work.
        if (ctx.signal.aborted) {
          meta.skipped.push({ strategy, reason: 'step timed out before this strategy' });
          continue;
        }

        if (!quota.reserve()) {
          meta.skipped.push({ strategy, reason: quota.reason ?? 'no quota' });
          continue;
        }

        try {
          const { metrics, raw } = await source.run(store.url, strategy);

          savePagespeedResult(
            store.id,
            {
              strategy,
              performance: metrics.scores.performance,
              accessibility: metrics.scores.accessibility,
              bestPractices: metrics.scores.bestPractices,
              seo: metrics.scores.seo,
              fcpMs: metrics.fcpMs,
              lcpMs: metrics.lcpMs,
              cls: metrics.cls,
              inpMs: metrics.inpMs,
              ttfbMs: metrics.ttfbMs,
              speedIndexMs: metrics.speedIndexMs,
              raw,
            },
            ctx.db,
          );

          if (metrics.runtimeError) {
            // 200 OK, but Lighthouse never got the page open. The row is stored
            // with null scores so the TTL keeps us from asking again tomorrow.
            meta.unanalysable.push({ strategy, code: metrics.runtimeError.code });
            ctx.logger.warn(
              { strategy, code: metrics.runtimeError.code },
              'pagespeed could not analyse the page',
            );
          } else {
            meta.fetched.push(strategy);
          }
        } catch (error) {
          if (error instanceof PagespeedError && error.quotaExceeded) {
            quota.trip();
            meta.skipped.push({ strategy, reason: error.message });
            ctx.logger.warn(
              { strategy },
              'pagespeed quota exhausted, skipping the rest of the run',
            );
            continue;
          }

          if (error instanceof PagespeedError && error.lighthouseErrorCode) {
            savePagespeedResult(
              store.id,
              {
                strategy,
                raw: { error: error.lighthouseErrorCode, message: error.message },
              },
              ctx.db,
            );
            meta.unanalysable.push({ strategy, code: error.lighthouseErrorCode });
            continue;
          }

          // Transport failures and 5xx: nothing is written, the store is retried
          // on the next run rather than cached as broken.
          throw error instanceof StepError
            ? error
            : new StepError((error as Error).message, { cause: error });
        }
      }

      meta.quotaUsed = quota.used;

      const didNothing = meta.fetched.length === 0 && meta.unanalysable.length === 0;
      return { status: didNothing ? 'SKIPPED' : 'OK', meta };
    },
  };
}
