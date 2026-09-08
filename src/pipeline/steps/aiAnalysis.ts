import {
  classifyLead,
  LEAD_CLASSIFIER_AGENT,
  LEAD_CLASSIFIER_PROMPT_VERSION,
  priorityForScore,
} from '../../ai/agents/leadClassifier.js';
import { evaluateSkipRules } from '../../ai/agents/skipRules.js';
import {
  AiOutputError,
  STORE_ANALYST_AGENT,
  analyseStore,
  type StoreAnalysis,
} from '../../ai/agents/storeAnalyst.js';
import { createOpenAiClient, type AiClient } from '../../ai/client.js';
import { buildStoreContext } from '../../ai/context.js';
import { selectScreenshots } from '../../ai/screenshots.js';
import { computeLeadScore } from '../../analysis/leadScore.js';
import { getConfig } from '../../config/index.js';
import { listContacts } from '../../db/repositories/contacts.js';
import { lastStepLog } from '../../db/repositories/stepLogs.js';
import { getLatestAnalysis, saveAiAnalysis } from '../../db/repositories/aiAnalyses.js';
import { getLatestAudit } from '../../db/repositories/audits.js';
import { StepError } from '../retry.js';
import type { PipelineStep, StepContext } from '../types.js';

/**
 * The AI analysis step (Epic 3).
 *
 * Runs both agents over one store: the analyst reads the audit, the classifier
 * buckets the lead. Between them sits arithmetic — the lead score — and before
 * them sit the skip rules, which can end the step without spending a call.
 *
 * Two decisions worth stating, because both are easy to get wrong later:
 *
 *   - **The analyst's issues are not written into `audit_issues`.** That table
 *     holds what a check observed. If a reading were written back into it, the
 *     next run's fact bundle would carry AI output as evidence, and the
 *     grounding guard would happily let the model cite its own previous
 *     invention. The reading lives in `ai_analyses.output_json` instead.
 *   - **A failed analysis does not fail the store's other work.** The step is
 *     soft-fail and records `AI_FAILED` on the row, so the audit and the
 *     contacts already collected stay usable.
 */

export interface AiAnalysisStepOptions {
  /** Injected by tests; the real client is built from OPENAI_API_KEY on first use. */
  client?: AiClient;
  /** Defaults to OPENAI_API_KEY. Passing it explicitly lets a test run keyless. */
  apiKey?: string | undefined;
  /** Attempts at a schema-valid answer per agent (task 3-04). */
  attempts?: number;
  screenshotLimit?: number;
  /** Overrides SCREENSHOTS_DIR. */
  screenshotsDir?: string | undefined;
  timeoutMs?: number;
}

export interface AiAnalysisStepMeta {
  skipped?: { reason: string; detail: string };
  category?: string;
  leadScore?: number;
  priority?: string;
  /** Issues the grounding guard threw away (task 3-05). */
  droppedIssues?: number;
  screenshots?: { attached: number; skipped: number };
  /** Tokens and wall time per agent (task 3-11). */
  usage?: {
    agent: string;
    tokensIn: number | null;
    tokensOut: number | null;
    durationMs: number;
    attempts: number;
  }[];
  promptVersions?: Record<string, string>;
}

export function createAiAnalysisStep(options: AiAnalysisStepOptions = {}): PipelineStep {
  let client: AiClient | undefined = options.client;
  /**
   * Null when no key is configured. Same reasoning as the PageSpeed step: a line
   * missing from `.env` is our problem, and marking every store FAILED for it
   * would destroy a run's worth of audit work.
   */
  const getClient = (): AiClient | null => {
    if (client) return client;
    const apiKey = 'apiKey' in options ? options.apiKey : getConfig().ai.apiKey;
    if (!apiKey) return null;
    client = createOpenAiClient({ apiKey });
    return client;
  };

  return {
    name: 'ai_analysis',
    scope: 'store',
    softFail: true,
    attempts: 1,
    // Two agents, each with up to three attempts at a long answer, plus reading
    // the screenshots off disk.
    timeoutMs: options.timeoutMs ?? 300_000,

    isSatisfied: (ctx) => {
      if (!ctx.store) return false;
      const analysis = getLatestAnalysis(ctx.store.id, LEAD_CLASSIFIER_AGENT, ctx.db);
      if (!analysis) return false;
      // A reading is stale once a newer audit exists: the facts it was made from
      // are no longer the facts on record.
      const audit = getLatestAudit(ctx.store.id, ctx.db);
      if (audit && audit.finished_at && audit.finished_at > analysis.created_at) return false;
      return analysis.status === 'OK';
    },

    run: async (ctx: StepContext) => {
      const store = ctx.store;
      if (!store) throw new StepError('ai_analysis is a store-scoped step', { retryable: false });

      const source = getClient();
      if (!source) {
        const reason = 'OPENAI_API_KEY is not set';
        ctx.logger.warn({ store: store.domain }, `ai analysis skipped: ${reason}`);
        return { status: 'SKIPPED', meta: { skipped: { reason, detail: reason } } };
      }

      const bundle = buildStoreContext(store, { db: ctx.db });
      const meta: AiAnalysisStepMeta = { usage: [], promptVersions: {} };

      /**
       * Zero contacts means two different things, and the difference decides
       * whether the store is dropped: "we looked and found nobody" is a skip,
       * "contact search has not run yet" is the normal state at this point in
       * the pipeline. The step log is what tells them apart — a count of zero
       * cannot.
       */
      const contactsSearched =
        lastStepLog({ runId: ctx.runId, storeId: store.id, step: 'contact_search' }, ctx.db) !==
        undefined;
      const skipRules = {
        contactCount: contactsSearched ? listContacts(store.id, ctx.db).length : null,
      };

      // Checked in code, before any call is paid for (task 3-09).
      const skip = evaluateSkipRules(bundle.context, skipRules);
      if (skip.skip) {
        const leadScore = computeLeadScore(bundle.context);
        saveAiAnalysis(
          {
            storeId: store.id,
            runId: ctx.runId,
            agent: LEAD_CLASSIFIER_AGENT,
            promptVersion: `${LEAD_CLASSIFIER_PROMPT_VERSION}/skip`,
            category: 'SKIP',
            leadScore: leadScore.score,
            priority: priorityForScore(leadScore.score),
            reason: skip.detail,
            status: 'SKIPPED',
          },
          ctx.db,
        );
        ctx.logger.info(
          { store: store.domain, reason: skip.reason },
          'store skipped before any AI call',
        );
        meta.skipped = { reason: skip.reason ?? 'skip', detail: skip.detail };
        meta.category = 'SKIP';
        meta.leadScore = leadScore.score;
        return { status: 'SKIPPED', meta };
      }

      const shots = await selectScreenshots(bundle.context.audit?.id ?? -1, {
        db: ctx.db,
        baseDir: options.screenshotsDir,
        limit: options.screenshotLimit,
        logger: ctx.logger,
      });
      meta.screenshots = { attached: shots.images.length, skipped: shots.skipped.length };

      let analysis: StoreAnalysis;
      try {
        analysis = await analyseStore({
          client: source,
          context: bundle.context,
          images: shots.images,
          attempts: options.attempts ?? 3,
          logger: ctx.logger,
          signal: ctx.signal,
        });
      } catch (error) {
        if (error instanceof AiOutputError) {
          saveAiAnalysis(
            {
              storeId: store.id,
              runId: ctx.runId,
              agent: STORE_ANALYST_AGENT,
              promptVersion: 'unknown',
              input: bundle.json,
              output: error.lastText,
              status: 'AI_FAILED',
              error: error.message,
            },
            ctx.db,
          );
        }
        throw error;
      }

      saveAiAnalysis(
        {
          storeId: store.id,
          runId: ctx.runId,
          agent: STORE_ANALYST_AGENT,
          promptVersion: `${analysis.promptVersion}+${analysis.promptHash}`,
          input: bundle.json,
          output: JSON.stringify(analysis.output),
          tokensIn: analysis.usage.tokensIn,
          tokensOut: analysis.usage.tokensOut,
          durationMs: analysis.usage.durationMs,
          status: 'OK',
        },
        ctx.db,
      );
      meta.droppedIssues = analysis.dropped.length;
      meta.usage!.push({
        agent: STORE_ANALYST_AGENT,
        tokensIn: analysis.usage.tokensIn,
        tokensOut: analysis.usage.tokensOut,
        durationMs: analysis.usage.durationMs,
        attempts: analysis.attempts,
      });
      meta.promptVersions![STORE_ANALYST_AGENT] =
        `${analysis.promptVersion}+${analysis.promptHash}`;

      const classification = await classifyLead({
        client: source,
        context: bundle.context,
        analysis: analysis.output,
        attempts: options.attempts ?? 3,
        logger: ctx.logger,
        signal: ctx.signal,
        skipRules,
      });

      saveAiAnalysis(
        {
          storeId: store.id,
          runId: ctx.runId,
          agent: LEAD_CLASSIFIER_AGENT,
          promptVersion: `${classification.promptVersion}+${classification.promptHash ?? 'skip'}`,
          output: classification.rawText,
          category: classification.category,
          leadScore: classification.leadScore.score,
          priority: classification.priority,
          reason: classification.reason,
          tokensIn: classification.usage?.tokensIn ?? null,
          tokensOut: classification.usage?.tokensOut ?? null,
          durationMs: classification.usage?.durationMs ?? null,
          status: 'OK',
        },
        ctx.db,
      );

      meta.category = classification.category;
      meta.leadScore = classification.leadScore.score;
      meta.priority = classification.priority;
      if (classification.usage) {
        meta.usage!.push({
          agent: LEAD_CLASSIFIER_AGENT,
          tokensIn: classification.usage.tokensIn,
          tokensOut: classification.usage.tokensOut,
          durationMs: classification.usage.durationMs,
          attempts: classification.attempts,
        });
      }
      meta.promptVersions![LEAD_CLASSIFIER_AGENT] = classification.promptVersion;

      return { status: 'OK', meta };
    },
  };
}
