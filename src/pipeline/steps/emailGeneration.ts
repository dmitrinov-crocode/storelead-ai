import { createOpenAiClient, type AiClient } from '../../ai/client.js';
import { buildStoreContext } from '../../ai/context.js';
import { LEAD_CLASSIFIER_AGENT, type LeadCategory } from '../../ai/agents/leadClassifier.js';
import { STORE_ANALYST_AGENT, type StoreAnalystOutput } from '../../ai/agents/storeAnalyst.js';
import { getLatestAnalysis } from '../../db/repositories/aiAnalyses.js';
import { getPrimaryContact } from '../../db/repositories/contacts.js';
import { getLatestEmail, listEarlierLetters, saveEmail } from '../../db/repositories/emails.js';
import { composeEmail } from '../../outreach/compose.js';
import { OUTREACH_AGENT } from '../../outreach/prompt.js';
import { StepError } from '../retry.js';
import type { PipelineStep } from '../types.js';

/**
 * The outreach step (Epic 5).
 *
 * It runs last, and it is the only step that needs almost everything before it:
 * the audit for facts, the analyst for what they mean, the classifier for why
 * this shop is a lead, and the contact search for who to write to. A store
 * missing the classification is skipped rather than written to blind — a letter
 * with no reason behind it is the bulk outreach the whole epic is avoiding.
 *
 * Nothing is sent. The step ends at `READY`, which is a draft waiting for a
 * human to approve it in the dashboard (task 6-08), or at `QC_FAILED`, which is
 * a draft waiting for a human to read the reasons it did not make it.
 */

export interface EmailGenerationStepOptions {
  /** Injected by tests; the real client is built from OPENAI_API_KEY on first use. */
  client?: AiClient;
  apiKey?: string | undefined;
  /** QC rounds per store (task 5-06). */
  rounds?: number;
  /** Writer attempts inside one round, on the programmatic checks of 5-05. */
  attemptsPerRound?: number;
  /** Overrides the repetition threshold of 5-07. */
  similarityThreshold?: number | undefined;
  /** How many earlier letters a draft is compared against. */
  compareAgainst?: number;
  timeoutMs?: number;
}

export function createEmailGenerationStep(options: EmailGenerationStepOptions = {}): PipelineStep {
  // Built lazily: a run whose stores were all skipped never needs a key.
  let client = options.client;
  const aiClient = (): AiClient => {
    client ??= createOpenAiClient(options.apiKey ? { apiKey: options.apiKey } : {});
    return client;
  };

  return {
    name: 'email_generation',
    scope: 'store',
    // One shop that cannot be written to must not end the run.
    softFail: true,
    attempts: 1,
    // Up to two QC rounds, each of which may spend several writer attempts.
    timeoutMs: options.timeoutMs ?? 300_000,

    isSatisfied: (ctx) => {
      if (!ctx.store) return false;
      const latest = getLatestEmail(ctx.store.id, ctx.db);
      // A rejected draft is not done: the next run should try again. A letter a
      // human has already ruled on is, whichever way they ruled.
      return latest !== undefined && ['READY', 'APPROVED', 'SKIPPED'].includes(latest.status);
    },

    run: async (ctx) => {
      const store = ctx.store;
      if (!store)
        throw new StepError('email_generation is a store-scoped step', { retryable: false });

      const classification = getLatestAnalysis(store.id, LEAD_CLASSIFIER_AGENT, ctx.db);
      if (!classification?.category) {
        // Writing without knowing why a shop is a lead is exactly the letter
        // this epic exists to avoid.
        ctx.logger.info('no classification for this store; nothing to write about');
        return { status: 'SKIPPED', meta: { reason: 'the store has no lead classification' } };
      }

      const analystRow = getLatestAnalysis(store.id, STORE_ANALYST_AGENT, ctx.db);
      const analysis = parseAnalysis(analystRow?.output_json);
      const contact = getPrimaryContact(store.id, ctx.db);
      const earlier = listEarlierLetters(
        { excludeStoreId: store.id, limit: options.compareAgainst ?? 500 },
        ctx.db,
      );

      const result = await composeEmail({
        client: aiClient(),
        context: buildStoreContext(store, { db: ctx.db }).context,
        category: classification.category as LeadCategory,
        categoryReason: classification.reason,
        ...(analysis ? { analysis } : {}),
        contactName: contact?.name ?? null,
        contactRole: contact?.role ?? null,
        earlier,
        ...(options.rounds === undefined ? {} : { rounds: options.rounds }),
        ...(options.attemptsPerRound === undefined
          ? {}
          : { attemptsPerRound: options.attemptsPerRound }),
        similarityThreshold: options.similarityThreshold,
        logger: ctx.logger,
        signal: ctx.signal,
      });

      if (result.status === 'SKIPPED' || result.draft === null) {
        return {
          status: 'SKIPPED',
          meta: { reason: result.reason, category: classification.category },
        };
      }

      const row = saveEmail(
        {
          storeId: store.id,
          runId: ctx.runId,
          contactId: contact?.id ?? null,
          subject: result.draft.subject,
          body: result.draft.body,
          wordCount: result.draft.wordCount,
          category: classification.category,
          promptVersion: result.draft.promptVersion,
          status: result.status,
          qc: result.qc?.checks ?? null,
          qcPassed: result.qc?.passed ?? null,
          similarity: result.repetition?.similarity ?? null,
        },
        ctx.db,
      );

      const meta = {
        agent: OUTREACH_AGENT,
        emailId: row.id,
        version: row.version,
        category: classification.category,
        words: result.draft.wordCount,
        rounds: result.rounds,
        facts: result.draft.factsUsed.map((fact) => fact.id),
        invented: result.draft.inventedFacts.length,
        similarity: result.repetition?.similarity ?? null,
        comparedAgainst: result.repetition?.compared ?? 0,
        tokensIn: result.draft.usage.tokensIn,
        tokensOut: result.draft.usage.tokensOut,
        qcTokensIn: result.qc?.usage?.tokensIn ?? null,
        ...(result.status === 'QC_FAILED' ? { reason: result.reason } : {}),
      };

      // A refused draft is stored, not thrown away, but the step says so: a run
      // report that counted it as a success would hide the failure.
      return { status: result.status === 'READY' ? 'OK' : 'SKIPPED', meta };
    },
  };
}

/** The analyst's reading, or undefined when the analysis step never ran or failed. */
function parseAnalysis(json: string | null | undefined): StoreAnalystOutput | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as StoreAnalystOutput;
  } catch {
    return undefined;
  }
}
