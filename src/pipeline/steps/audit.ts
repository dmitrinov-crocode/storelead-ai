import { getConfig } from '../../config/index.js';
import { getLatestAudit } from '../../db/repositories/audits.js';
import { cooldownFor, noteRefusal, noteSuccess } from '../../db/repositories/cooldowns.js';
import { setStoreStatus } from '../../db/repositories/stores.js';
import { auditStore, type AuditReport } from '../../audit/auditStore.js';
import { AuditPool } from '../../audit/pool.js';
import { StepError } from '../retry.js';
import type { PipelineStep } from '../types.js';

/**
 * The audit step (tasks 2-08, 2-18).
 *
 * The orchestrator already runs store steps in parallel, so the pool is here for
 * the browser it owns — one Chromium shared by every store, restarted on a
 * budget, and closed in `teardown` so the CLI can exit.
 */

export interface AuditStepOptions {
  pool?: AuditPool;
  skipLinks?: boolean;
  skipCart?: boolean;
  screenshotsDir?: string;
  timeoutMs?: number;
}

export function createAuditStep(options: AuditStepOptions = {}): PipelineStep {
  const pool =
    options.pool ??
    new AuditPool({
      concurrency: getConfig().pipeline.storeConcurrency,
      session: {},
    });

  return {
    name: 'audit',
    scope: 'store',
    // One store's storefront falling over must not end the run.
    softFail: true,
    // A browser pass is expensive and the checks already retry internally.
    attempts: 1,
    timeoutMs: options.timeoutMs ?? 300_000,

    isSatisfied: (ctx) => {
      if (!ctx.store) return false;
      const latest = getLatestAudit(ctx.store.id, ctx.db);
      if (!latest) return false;
      // A FAILED or still-RUNNING audit is worth another attempt; the rest are final.
      return latest.status === 'OK' || latest.status === 'PARTIAL' || latest.status === 'BLOCKED';
    },

    run: async (ctx) => {
      const store = ctx.store;
      if (!store) throw new StepError('audit is a store-scoped step', { retryable: false });

      // The audit is 30 of the 38 requests a store receives, so this is the
      // check that matters most: a shop that refused us is not audited again
      // until the wait expires, `--force` included.
      const cooling = cooldownFor(store.domain, ctx.db);
      if (cooling) {
        const minutes = Math.ceil(cooling.msRemaining / 60_000);
        ctx.logger.info({ until: cooling.until.toISOString(), minutes }, 'domain is cooling down');
        return {
          status: 'SKIPPED',
          meta: {
            reason: `domain is cooling down after ${cooling.reason}`,
            until: cooling.until.toISOString(),
            minutes,
          },
        };
      }

      const [outcome] = await pool.map([store], (target, session) =>
        auditStore({
          store: target,
          session,
          runId: ctx.runId,
          db: ctx.db,
          logger: ctx.logger,
          ...(options.skipLinks === undefined ? {} : { skipLinks: options.skipLinks }),
          ...(options.skipCart === undefined ? {} : { skipCart: options.skipCart }),
          ...(options.screenshotsDir === undefined
            ? {}
            : { screenshotsDir: options.screenshotsDir }),
        }),
      );

      if (!outcome || !outcome.ok) {
        throw new StepError(outcome?.error.message ?? 'audit produced no result');
      }
      const report: AuditReport = outcome.value;

      if (report.status === 'FAILED') {
        // Retryable: a shop that is down today may answer tomorrow.
        throw new StepError(report.audit.error ?? 'the storefront could not be audited');
      }

      if (report.status === 'BLOCKED') {
        // Detecting the wall was never the problem; walking into it again was.
        const cooldown = noteRefusal(
          store.domain,
          { reason: 'bot_challenge', status: null },
          ctx.db,
        );
        ctx.logger.warn(
          { vendor: report.botProtection.vendor, until: cooldown.until.toISOString() },
          'bot protection hit; backing off',
        );
        setStoreStatus(
          store.id,
          'SKIPPED',
          report.audit.error ?? 'blocked by bot protection',
          ctx.db,
        );
      } else {
        noteSuccess(store.domain, ctx.db);
        setStoreStatus(store.id, 'AUDITED', undefined, ctx.db);
      }

      return {
        status: 'OK',
        meta: {
          auditId: report.audit.id,
          auditStatus: report.status,
          issues: report.issues.length,
          ...report.counts,
          blocked: report.blocked,
          pagesAudited: report.pages.filter((p) => p.availability === 'ok').length,
        },
      };
    },

    teardown: () => pool.close(),
  };
}
