import { z } from 'zod';
import {
  computeLeadScore,
  explainLeadScore,
  type LeadScoreResult,
} from '../../analysis/leadScore.js';
import { silentLogger, type Logger } from '../../lib/logger.js';
import type { AiClient } from '../client.js';
import { CONTEXT_VERSION, type StoreContext } from '../context.js';
import { AiOutputError, promptHash, type StoreAnalystOutput } from './storeAnalyst.js';
import { evaluateSkipRules, type SkipRuleOptions, type SkipVerdict } from './skipRules.js';

/**
 * Agent 2 — Lead Classifier (task 3-07).
 *
 * Puts one shop in one of ten buckets and says why. What it explicitly does not
 * do is produce the lead score: that is arithmetic (task 3-08), computed before
 * the model is called and handed to it as a fact. The model's job is the label
 * and the sentence a human will read next to it.
 *
 * `priority` is the one place the two could contradict each other. The model is
 * asked for its reading, but the stored priority is banded from the computed
 * score — two numbers in the same row that disagree are worse than one. When the
 * model's reading differs it is kept in the output for calibration (task M2-02),
 * never used for sorting.
 */

export const LEAD_CLASSIFIER_AGENT = 'lead_classifier';
export const LEAD_CLASSIFIER_PROMPT_VERSION = '1';

/** The ten buckets. `SKIP` is reached by code (task 3-09), never by the model. */
export const LEAD_CATEGORIES = [
  'IDEAL_PROSPECT',
  'TECHNICAL_PROBLEMS',
  'PERFORMANCE_PROBLEMS',
  'UX_PROBLEMS',
  'REDESIGN_OPPORTUNITY',
  'HIGH_REVENUE_LOW_QUALITY',
  'HEAVY_APP_STACK',
  'GROWING_STORE',
  'HEALTHY_STORE',
  'SKIP',
] as const;
export type LeadCategory = (typeof LEAD_CATEGORIES)[number];

/** What the model may choose from — everything but the code-only bucket. */
export const MODEL_CATEGORIES = LEAD_CATEGORIES.filter((c) => c !== 'SKIP');

export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Score bands. HIGH is deliberately narrow: a priority everything meets is not one. */
export const PRIORITY_BANDS = { high: 70, medium: 45 } as const;

export function priorityForScore(score: number): Priority {
  if (score >= PRIORITY_BANDS.high) return 'HIGH';
  if (score >= PRIORITY_BANDS.medium) return 'MEDIUM';
  return 'LOW';
}

export const leadClassifierOutputSchema = z.object({
  category: z.enum(MODEL_CATEGORIES as [string, ...string[]]),
  priority: z.enum(PRIORITIES),
  reason: z.string().min(1),
});

export type LeadClassifierOutput = z.infer<typeof leadClassifierOutputSchema>;

export const LEAD_CLASSIFIER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'priority', 'reason'],
  properties: {
    category: { type: 'string', enum: [...MODEL_CATEGORIES] },
    priority: { type: 'string', enum: [...PRIORITIES] },
    reason: {
      type: 'string',
      description: 'Two sentences at most, naming the specific facts that decided the category.',
    },
  },
};

export const LEAD_CLASSIFIER_SYSTEM_PROMPT = `You sort audited Shopify shops into one bucket each,
for an agency that fixes storefronts. You are given the facts about one shop, the analyst's reading
of it, and a lead score that was computed arithmetically — you do not produce that score.

Choose exactly one category:

  IDEAL_PROSPECT           Sells enough to afford the work and has several real, fixable problems.
  TECHNICAL_PROBLEMS       Things are broken: errors, failing requests, broken links or images.
  PERFORMANCE_PROBLEMS     Mainly slow. PageSpeed and the field metrics are the story.
  UX_PROBLEMS              Works, but is awkward to use — mobile layout, navigation, tap targets.
  REDESIGN_OPPORTUNITY     Dated theme or architecture; the problem is the whole storefront.
  HIGH_REVENUE_LOW_QUALITY Notable revenue behind a storefront that does not match it.
  HEAVY_APP_STACK          Many apps, and they are a plausible cause of what was measured.
  GROWING_STORE            Growth is the notable fact; problems are secondary.
  HEALTHY_STORE            Little was found wrong. Say so rather than inventing a reason to call.

Rules:

1. Use only the facts given. Never introduce a problem the analyst did not report or a number that
   is not in the input.
2. The reason must name the specific facts that decided it — a metric, a finding, a figure. "Has
   several issues" is not a reason; "add to cart fails on the product page and mobile performance
   is 24" is.
3. HEALTHY_STORE is a real answer. A shop with nothing wrong is not a lead, and pretending
   otherwise produces a letter no merchant will answer.
4. Prefer the category that names the shop's dominant problem. When two fit equally, pick the one
   a merchant would recognise as their own biggest complaint.
5. Give your reading of priority as well. It is recorded, but the sorting uses the computed score,
   so do not try to talk the score up or down.`;

export interface ClassifyLeadOptions {
  client: AiClient;
  context: StoreContext;
  /** The analyst's reading. Omitted when the analysis step failed. */
  analysis?: StoreAnalystOutput | undefined;
  attempts?: number;
  logger?: Logger;
  signal?: AbortSignal | undefined;
  skipRules?: SkipRuleOptions;
}

export interface LeadClassification {
  category: LeadCategory;
  /** Banded from the computed score, never from the model. */
  priority: Priority;
  reason: string;
  leadScore: LeadScoreResult;
  /** Set when a code rule decided this without calling the model (task 3-09). */
  skip: SkipVerdict | null;
  /** The model's own priority, kept for calibration when it differs. */
  modelPriority: Priority | null;
  promptVersion: string;
  promptHash: string | null;
  attempts: number;
  usage: {
    tokensIn: number | null;
    tokensOut: number | null;
    durationMs: number;
    model: string;
  } | null;
  rawText: string | null;
}

export async function classifyLead(options: ClassifyLeadOptions): Promise<LeadClassification> {
  const logger = options.logger ?? silentLogger();
  const context = options.context;
  const leadScore = computeLeadScore(context);
  const version = `${LEAD_CLASSIFIER_PROMPT_VERSION}/ctx${CONTEXT_VERSION}`;

  const skip = evaluateSkipRules(context, options.skipRules ?? {});
  if (skip.skip) {
    logger.info(
      { reason: skip.reason, detail: skip.detail },
      'store skipped before the classifier',
    );
    return {
      category: 'SKIP',
      priority: 'LOW',
      reason: skip.detail,
      leadScore,
      skip,
      modelPriority: null,
      promptVersion: version,
      promptHash: null,
      attempts: 0,
      usage: null,
      rawText: null,
    };
  }

  const user = buildLeadClassifierPrompt(context, leadScore, options.analysis);
  const hash = promptHash(LEAD_CLASSIFIER_SYSTEM_PROMPT, user);
  const attempts = options.attempts ?? 3;

  let lastError: unknown;
  let lastText = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await options.client.complete({
      system: LEAD_CLASSIFIER_SYSTEM_PROMPT,
      user:
        attempt === 1
          ? user
          : `${user}\n\nYour previous answer was rejected: ${String(lastError)}. Answer again with JSON matching the schema exactly.`,
      schemaName: 'lead_classification',
      jsonSchema: LEAD_CLASSIFIER_JSON_SCHEMA,
      signal: options.signal,
    });

    lastText = result.text;
    let parsed: LeadClassifierOutput;
    try {
      parsed = leadClassifierOutputSchema.parse(JSON.parse(result.text));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn({ attempt, err: lastError }, 'classifier answer did not fit the schema');
      continue;
    }

    const priority = priorityForScore(leadScore.score);
    if (priority !== parsed.priority) {
      logger.debug(
        { computed: priority, model: parsed.priority, score: leadScore.score },
        'model priority differs from the score band; the score wins',
      );
    }

    return {
      category: parsed.category as LeadCategory,
      priority,
      reason: parsed.reason,
      leadScore,
      skip: null,
      modelPriority: parsed.priority,
      promptVersion: version,
      promptHash: hash,
      attempts: attempt,
      usage: {
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs: result.durationMs,
        model: result.model,
      },
      rawText: result.text,
    };
  }

  throw new AiOutputError(`the classifier did not answer in ${attempts} attempts`, {
    attempts,
    lastText,
    cause: lastError,
  });
}

export function buildLeadClassifierPrompt(
  context: StoreContext,
  leadScore: LeadScoreResult,
  analysis?: StoreAnalystOutput,
): string {
  const lines: string[] = [
    `Shop: ${context.store.domain} (${context.store.country ?? 'country unknown'})`,
    '',
    'Business facts:',
    `  rank: ${format(context.business.rank)}`,
    `  revenue estimate: ${format(context.business.revenueEstimate)}`,
    `  traffic estimate: ${format(context.business.trafficEstimate)}`,
    `  growth rate: ${format(context.business.growthRate)}`,
    `  products: ${format(context.business.productsCount)}`,
    `  apps: ${format(context.business.appsCount)}${context.apps?.size ? ` (${context.apps.size} stack)` : ''}`,
    '',
    `Theme: ${context.theme?.name ?? 'unknown'}` +
      (context.theme?.freshness ? `, ${context.theme.freshness}` : '') +
      (context.theme?.ageMonths !== null && context.theme?.ageMonths !== undefined
        ? `, ${context.theme.ageMonths} months old`
        : ''),
    '',
    'PageSpeed:',
    ...(context.pagespeed.length > 0
      ? context.pagespeed.map(
          (row) =>
            `  ${row.strategy}: performance ${format(row.performance)}, LCP ${format(row.lcpMs)}ms,` +
            ` CLS ${format(row.cls)}, INP ${format(row.inpMs)}ms`,
        )
      : ['  not measured']),
    '',
    `Audit findings: ${
      context.audit
        ? `${context.audit.counts.CRITICAL} critical, ${context.audit.counts.MAJOR} major, ${context.audit.counts.MINOR} minor`
        : 'no audit'
    }`,
  ];

  if (analysis) {
    lines.push(
      '',
      "Analyst's reading:",
      `  scores — ux ${analysis.scores.ux}, cro ${analysis.scores.cro}, seo ${analysis.scores.seo}, performance ${analysis.scores.performance}`,
      ...analysis.issues.map((issue) => `  [${issue.severity}] ${issue.title} — ${issue.impact}`),
      ...(analysis.signals.insufficientEvidence
        ? ['  the analyst reported the evidence was too thin to judge this shop']
        : []),
    );
  }

  lines.push(
    '',
    `Computed lead score: ${leadScore.score}/100 (evidence coverage ${Math.round(leadScore.coverage * 100)}%)`,
    ...explainLeadScore(leadScore).map((line) => `  ${line}`),
  );

  return lines.join('\n');
}

function format(value: number | null | undefined): string {
  return value === null || value === undefined ? 'unknown' : String(value);
}
