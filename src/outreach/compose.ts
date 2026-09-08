import type { AiClient } from '../ai/client.js';
import type { StoreContext } from '../ai/context.js';
import type { StoreAnalystOutput } from '../ai/agents/storeAnalyst.js';
import type { LeadCategory } from '../ai/agents/leadClassifier.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { briefFor, isKnownCategory } from './categories.js';
import { generateEmail, type EmailDraft } from './agent.js';
import { reviewEmail, type QcReport } from './qc.js';
import { detectRepetition, type EarlierLetter, type RepetitionResult } from './similarity.js';

/**
 * The regeneration loop (task 5-06): write, check, review, and stop.
 *
 * Two loops, nested, and the split is the point. The inner one lives in the
 * agent and turns on the programmatic checks of 5-05 — free to run, so a draft
 * that is 300 words long is rewritten without anybody paying for an opinion
 * about it. The outer one is here and turns on the QC verdict of 5-04, which
 * costs a call, so it only ever sees drafts that already passed the cheap tests.
 *
 * Both are bounded, and the bound is the feature: `QC_FAILED` with reasons is a
 * legitimate outcome. The alternative — retrying until something passes — is how
 * a pipeline spends an afternoon and a hundred dollars talking itself into a
 * letter it should not send.
 *
 * Nothing here decides to contact anybody. `HEALTHY_STORE` and `SKIP` never get
 * a draft at all (task 5-02), and what does get written stops at `READY` for a
 * human to approve.
 */

/** Where a store ended up. `READY` and `QC_FAILED` map onto `emails.status`. */
export type ComposeStatus = 'READY' | 'QC_FAILED' | 'SKIPPED';

export interface ComposeResult {
  status: ComposeStatus;
  /** Null only when the category meant no letter was written at all. */
  draft: EmailDraft | null;
  qc: QcReport | null;
  repetition: RepetitionResult | null;
  /** Why a shop was passed over, or why the draft failed. */
  reason: string | null;
  /** Writer rounds spent, so a run report can see what a letter cost. */
  rounds: number;
}

export interface ComposeEmailOptions {
  client: AiClient;
  context: StoreContext;
  category: LeadCategory;
  categoryReason?: string | null;
  analysis?: StoreAnalystOutput | undefined;
  contactName?: string | null;
  contactRole?: string | null;
  /** Letters already written, for the repetition check of 5-07. */
  earlier?: readonly EarlierLetter[];
  /** QC rounds, each of which may spend several writer attempts. */
  rounds?: number;
  /** Writer attempts inside one round, on the programmatic checks. */
  attemptsPerRound?: number;
  similarityThreshold?: number | undefined;
  logger?: Logger;
  signal?: AbortSignal | undefined;
}

export async function composeEmail(options: ComposeEmailOptions): Promise<ComposeResult> {
  const logger = options.logger ?? silentLogger();

  // A label this table does not know still gets a letter, on the generic brief —
  // but silently is the wrong way to do it. Stale seed data produced
  // `HIGH_REVENUE_OPPORTUNITY` in the 2026-09-08 batch and nothing said so.
  if (!isKnownCategory(options.category)) {
    logger.warn(
      { category: options.category },
      'unknown lead category; falling back to the generic brief',
    );
  }
  const brief = briefFor(options.category);

  // A shop with nothing wrong is not a lead. Writing anyway would mean inventing
  // a reason to make contact, which is the failure this epic is built to avoid.
  if (!brief.write) {
    logger.info({ category: options.category }, 'no letter is written for this category');
    return {
      status: 'SKIPPED',
      draft: null,
      qc: null,
      repetition: null,
      reason: brief.skipReason ?? `no letter is written for ${options.category}`,
      rounds: 0,
    };
  }

  const maxRounds = options.rounds ?? 2;
  const earlier = options.earlier ?? [];
  let feedback: string | null = null;
  let last: { draft: EmailDraft; qc: QcReport | null; repetition: RepetitionResult } | null = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    const draft = await generateEmail({
      client: options.client,
      context: options.context,
      category: options.category,
      categoryReason: options.categoryReason ?? null,
      ...(options.analysis ? { analysis: options.analysis } : {}),
      contactName: options.contactName ?? null,
      contactRole: options.contactRole ?? null,
      ...(options.attemptsPerRound === undefined ? {} : { attempts: options.attemptsPerRound }),
      feedback,
      logger,
      signal: options.signal,
    });

    const repetition = detectRepetition({ subject: draft.subject, body: draft.body }, earlier, {
      ...(options.similarityThreshold === undefined
        ? {}
        : { threshold: options.similarityThreshold }),
    });

    // A draft that still fails the free checks is not worth a paid opinion.
    if (!draft.passedChecks) {
      last = { draft, qc: null, repetition };
      feedback = draft.failures.map((failure) => failure.message).join(' ');
      logger.info(
        { round, failures: draft.failures.map((f) => f.check) },
        'draft failed the programmatic checks; not sending it to QC',
      );
      continue;
    }

    const qc = await reviewEmail({
      client: options.client,
      subject: draft.subject,
      body: draft.body,
      facts: draft.factsUsed,
      category: options.category,
      contactName: options.contactName ?? null,
      length: { wordCount: draft.wordCount, passed: true },
      repetition: { similarity: repetition.similarity, threshold: repetition.threshold },
      logger,
      signal: options.signal,
    });

    last = { draft, qc, repetition };
    if (qc.passed) {
      logger.info({ round, words: draft.wordCount }, 'draft passed QC');
      return { status: 'READY', draft, qc, repetition, reason: null, rounds: round };
    }

    feedback = qc.failures.join(' ');
    logger.info({ round, failures: qc.failures.length }, 'draft refused by QC');
  }

  // Everything is kept: the reasons are what the calibration of 5-09 reads, and
  // a human with a failed draft in front of them can still judge it.
  const reason =
    last?.qc?.failures.join(' ') ??
    last?.draft.failures.map((failure) => failure.message).join(' ') ??
    'no draft survived the regeneration loop';

  return {
    status: 'QC_FAILED',
    draft: last?.draft ?? null,
    qc: last?.qc ?? null,
    repetition: last?.repetition ?? null,
    reason,
    rounds: maxRounds,
  };
}
