import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { IssueCategory, IssuePage, IssueSeverity } from '../../db/types.js';
import { silentLogger, type Logger } from '../../lib/logger.js';
import type { AiClient, CompletionResult } from '../client.js';
import { CONTEXT_VERSION, type StoreContext } from '../context.js';
import type { PromptImage } from '../screenshots.js';

/**
 * Agent 1 — Store Analyst (tasks 3-03…3-06).
 *
 * Turns the fact bundle into a reading of the shop: which findings actually
 * matter, what they cost the merchant, and three scores. What it must never do
 * is add a fact, so two things constrain it:
 *
 *   - Every issue it reports has to name the `audit_issues.id` it came from.
 *     The id is in the bundle; an issue quoting one that is not gets dropped by
 *     the grounding guard below and logged (task 3-05). The model is told this
 *     in the prompt, but the guard does not trust the telling.
 *   - Scores are given as a checklist, not as a free judgement (task 3-06), and
 *     the checklist only names things the audit measures. A criterion we cannot
 *     observe would be answered by invention.
 */

export const STORE_ANALYST_AGENT = 'store_analyst';

/**
 * Bumped by hand whenever the prompt or the schema changes meaning. Stored with
 * every result (task 3-10) so two runs can be told apart when the reading of the
 * same shop changes.
 */
export const STORE_ANALYST_PROMPT_VERSION = '1';

export const ISSUE_CATEGORIES = ['technical', 'performance', 'ux', 'cro', 'seo'] as const;
export const ISSUE_SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export const ISSUE_PAGES = [
  'homepage',
  'collection',
  'product',
  'cart',
  'checkout',
  'site',
] as const;

/** Scores are 0-100; the model is asked for whole numbers and we clamp anyway. */
const SCORE_MIN = 0;
const SCORE_MAX = 100;

export const storeAnalystOutputSchema = z.object({
  issues: z.array(
    z.object({
      /** `audit_issues.id`, the anchor the grounding guard checks. */
      evidenceId: z.number().int(),
      page: z.enum(ISSUE_PAGES),
      category: z.enum(ISSUE_CATEGORIES),
      severity: z.enum(ISSUE_SEVERITIES),
      title: z.string().min(1),
      /** What it costs the merchant, in their terms rather than ours. */
      impact: z.string().min(1),
    }),
  ),
  scores: z.object({
    ux: z.number(),
    cro: z.number(),
    seo: z.number(),
    performance: z.number(),
  }),
  signals: z.object({
    /** Free-form, short: what stood out that is not an issue. */
    strengths: z.array(z.string()),
    /** Where the shop looks like it is investing, if anywhere. */
    momentum: z.string(),
    /** Set when the audit saw too little to judge the shop at all. */
    insufficientEvidence: z.boolean(),
  }),
});

export type StoreAnalystOutput = z.infer<typeof storeAnalystOutputSchema>;
export type StoreAnalystIssue = StoreAnalystOutput['issues'][number];

/**
 * The schema as the API needs it. Written out rather than generated because
 * strict structured outputs accept a narrow subset of JSON Schema — every
 * property required, no `additionalProperties`, and no numeric bounds. The
 * bounds live in `clampScores` instead, which is why they are absent here.
 */
export const STORE_ANALYST_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['issues', 'scores', 'signals'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['evidenceId', 'page', 'category', 'severity', 'title', 'impact'],
        properties: {
          evidenceId: {
            type: 'integer',
            description: 'The id of the audit finding this is based on. Never invent one.',
          },
          page: { type: 'string', enum: [...ISSUE_PAGES] },
          category: { type: 'string', enum: [...ISSUE_CATEGORIES] },
          severity: { type: 'string', enum: [...ISSUE_SEVERITIES] },
          title: { type: 'string', description: 'One line, plain language, no jargon.' },
          impact: {
            type: 'string',
            description: 'What this costs the merchant. One or two sentences.',
          },
        },
      },
    },
    scores: {
      type: 'object',
      additionalProperties: false,
      required: ['ux', 'cro', 'seo', 'performance'],
      properties: {
        ux: { type: 'integer', description: '0-100.' },
        cro: { type: 'integer', description: '0-100.' },
        seo: { type: 'integer', description: '0-100.' },
        performance: { type: 'integer', description: '0-100.' },
      },
    },
    signals: {
      type: 'object',
      additionalProperties: false,
      required: ['strengths', 'momentum', 'insufficientEvidence'],
      properties: {
        strengths: { type: 'array', items: { type: 'string' } },
        momentum: { type: 'string' },
        insufficientEvidence: { type: 'boolean' },
      },
    },
  },
};

export const STORE_ANALYST_SYSTEM_PROMPT = `You are a Shopify storefront auditor. You read the
findings of an automated audit of one shop and report what actually matters to the merchant.

Rules, in order of importance:

1. Never state a fact that is not in the input. You have no knowledge of this shop beyond what you
   are given. If something is absent from the input, it was not measured — that is not the same as
   it being fine, and it is not something you may report either way.
2. Every issue you report must carry the "evidenceId" of the audit finding it is based on. Findings
   are listed under audit.issues, each with an "id". Do not report an issue you cannot anchor to one
   of those ids. Reporting fewer, anchored issues is always better than reporting more.
3. Do not repeat the audit's wording. The audit says what was observed; you say why it matters to
   someone selling on this shop. Write the impact in the merchant's terms — lost orders, abandoned
   carts, traffic that never arrives — not in technical ones.
4. Merge findings that a merchant would experience as one problem, and keep the id of the clearest
   piece of evidence. Fifty small tap targets on one page are one problem, not fifty.
5. Screenshots are supporting evidence, not a source of new claims. Use them to judge severity and
   to check that a finding is real; if a screenshot contradicts a finding, leave the finding out.
6. Set signals.insufficientEvidence to true when the audit was blocked, the pages did not load, or
   what was collected is too thin to judge the shop. Say so rather than filling the gap.

Scoring. Give four scores from 0 to 100, where 100 is "nothing found wrong in what we measured".
Judge only against this checklist — do not invent criteria, and do not score a criterion the input
does not cover; ignore it and score on the rest.

  ux (how the shop feels to use): mobile layout — sideways scrolling, tap target size, overlapping
    controls, text size; navigation and search present and working; images that load; the page
    reachable at all; popups and consent banners that can be dismissed.
  cro (whether it can sell): add to cart working and confirmed by the cart itself; the cart flow —
    quantity, removal, reaching checkout; product page essentials — price, availability, variants,
    images, description; checkout opening and accepting details; trust content such as shipping and
    returns information.
  seo (whether it can be found): title, meta description, one H1, canonical, robots and sitemap,
    product structured data, image alt attributes, and broken internal links.
  performance (whether it is fast enough): the PageSpeed mobile and desktop scores and the field
    metrics beside them — LCP, CLS, INP, TTFB. Weigh mobile above desktop. If PageSpeed is missing
    or returned a runtime error, score performance on nothing else and lower your confidence
    instead of guessing.

A shop with no findings in a category scores high there. A shop where that category was never
measured is not the same thing: prefer a middling score and say so in signals.`;

export interface AnalyseStoreOptions {
  client: AiClient;
  context: StoreContext;
  images?: readonly PromptImage[];
  /** Attempts at getting a valid answer, invalid JSON included (task 3-04). */
  attempts?: number;
  maxOutputTokens?: number;
  logger?: Logger;
  signal?: AbortSignal | undefined;
}

export interface DroppedIssue {
  evidenceId: number;
  title: string;
  reason: 'unknown-evidence-id';
}

export interface StoreAnalysis {
  output: StoreAnalystOutput;
  /** Issues the model produced that no audit finding backs (task 3-05). */
  dropped: DroppedIssue[];
  promptVersion: string;
  /** Identifies the exact prompt text, so a silent edit cannot pass for the same run. */
  promptHash: string;
  attempts: number;
  usage: { tokensIn: number | null; tokensOut: number | null; durationMs: number; model: string };
  /** The reply as it arrived, kept for `ai_analyses.output_json`. */
  rawText: string;
}

/** Thrown when no attempt produced an answer that fits the schema (task 3-04). */
export class AiOutputError extends Error {
  readonly attempts: number;
  readonly lastText: string;

  constructor(message: string, options: { attempts: number; lastText: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AiOutputError';
    this.attempts = options.attempts;
    this.lastText = options.lastText;
    // The step turns this into AI_FAILED; retrying the API will not fix a model
    // that cannot answer in the shape it was given.
    Object.assign(this, { retryable: false });
  }
}

export function promptHash(system: string, user: string): string {
  return createHash('sha256').update(`${system}\n---\n${user}`).digest('hex').slice(0, 16);
}

/**
 * The user half of the prompt. Kept separate from the call so a test can read
 * exactly what the model would be told, and so the hash covers it.
 */
export function buildStoreAnalystPrompt(context: StoreContext, json: string): string {
  const lines = [
    `Shop: ${context.store.domain} (${context.store.country ?? 'country unknown'})`,
    '',
    'Audit facts as JSON. The ids under audit.issues are what your evidenceId must match:',
    json,
  ];

  if (context.meta.truncated) {
    lines.splice(
      2,
      0,
      `Note: this bundle was trimmed to fit a size limit (${context.meta.trimmed.join(', ')}).` +
        ` ${context.meta.issuesOmitted} finding(s) the audit made are not listed here.` +
        ' The counts under audit.counts are complete; judge accordingly.',
      '',
    );
  }
  if (context.audit?.blocked) {
    lines.splice(
      2,
      0,
      'Note: the audit was blocked by bot protection, so the pages were not read.',
      '',
    );
  }

  return lines.join('\n');
}

export async function analyseStore(options: AnalyseStoreOptions): Promise<StoreAnalysis> {
  const logger = options.logger ?? silentLogger();
  const attempts = options.attempts ?? 3;
  const context = options.context;
  const user = buildStoreAnalystPrompt(context, serialiseForPrompt(context));
  const hash = promptHash(STORE_ANALYST_SYSTEM_PROMPT, user);

  let lastError: unknown;
  let lastText = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // A transport failure is deliberately not caught here: it is the client's
    // business, which has its own retry policy and its own idea of what is
    // worth repeating. This loop exists for answers, not for connections.
    const result: CompletionResult = await options.client.complete({
      system: STORE_ANALYST_SYSTEM_PROMPT,
      user: attempt === 1 ? user : `${user}\n\n${retryNote(lastError)}`,
      ...(options.images ? { images: options.images } : {}),
      schemaName: 'store_analysis',
      jsonSchema: STORE_ANALYST_JSON_SCHEMA,
      maxOutputTokens: options.maxOutputTokens,
      signal: options.signal,
    });

    lastText = result.text;
    const parsed = parseOutput(result.text);
    if (!parsed.ok) {
      lastError = parsed.error;
      logger.warn(
        { attempt, err: parsed.error, preview: result.text.slice(0, 200) },
        'AI answer did not fit the schema',
      );
      continue;
    }

    const grounded = applyGroundingGuard(parsed.value, context, logger);
    return {
      output: grounded.output,
      dropped: grounded.dropped,
      promptVersion: `${STORE_ANALYST_PROMPT_VERSION}/ctx${CONTEXT_VERSION}`,
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

  throw new AiOutputError(`the model did not return a valid analysis in ${attempts} attempts`, {
    attempts,
    lastText,
    cause: lastError,
  });
}

/**
 * The grounding guard (task 3-05). An issue whose `evidenceId` is not one of
 * this audit's findings is dropped, not corrected: there is no honest way to
 * guess which finding the model meant, and a claim without evidence is exactly
 * what this project refuses to send to a merchant.
 */
export function applyGroundingGuard(
  output: StoreAnalystOutput,
  context: StoreContext,
  logger: Logger = silentLogger(),
): { output: StoreAnalystOutput; dropped: DroppedIssue[] } {
  const known = new Set((context.audit?.issues ?? []).map((issue) => issue.id));
  const kept: StoreAnalystIssue[] = [];
  const dropped: DroppedIssue[] = [];

  for (const issue of output.issues) {
    if (known.has(issue.evidenceId)) {
      kept.push(issue);
      continue;
    }
    dropped.push({
      evidenceId: issue.evidenceId,
      title: issue.title,
      reason: 'unknown-evidence-id',
    });
  }

  if (dropped.length > 0) {
    logger.warn(
      { dropped: dropped.length, ids: dropped.map((d) => d.evidenceId) },
      'issues dropped: evidence id not in this audit',
    );
  }

  return { output: { ...output, issues: kept, scores: clampScores(output.scores) }, dropped };
}

/**
 * Bounds live here rather than in the schema because strict structured outputs
 * reject `minimum`/`maximum`. A model that answers 120 is not worth a retry, but
 * a 120 written into the database would quietly break every comparison later.
 */
export function clampScores(scores: StoreAnalystOutput['scores']): StoreAnalystOutput['scores'] {
  const clamp = (value: number): number =>
    Math.min(SCORE_MAX, Math.max(SCORE_MIN, Math.round(value)));
  return {
    ux: clamp(scores.ux),
    cro: clamp(scores.cro),
    seo: clamp(scores.seo),
    performance: clamp(scores.performance),
  };
}

type ParseResult = { ok: true; value: StoreAnalystOutput } | { ok: false; error: string };

export function parseOutput(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not JSON: ${(error as Error).message}` };
  }
  const parsed = storeAnalystOutputSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map(describeZodIssue).join('; ') };
  }
  return { ok: true, value: parsed.data };
}

function describeZodIssue(issue: { path: PropertyKey[]; message: string }): string {
  const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${where}: ${issue.message}`;
}

/** Told what was wrong, a model usually fixes it; told nothing, it repeats itself. */
function retryNote(error: unknown): string {
  return [
    'Your previous answer was rejected and could not be used.',
    typeof error === 'string' ? `Reason: ${error}` : '',
    'Answer again with JSON matching the schema exactly. No prose, no markdown fence.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The bundle is already serialised by `buildStoreContext`; this re-serialises the
 * possibly-trimmed object so the prompt and the stored input never disagree.
 */
function serialiseForPrompt(context: StoreContext): string {
  return JSON.stringify(context, (_key, value: unknown) => (value === null ? undefined : value));
}

export type { IssueCategory, IssuePage, IssueSeverity };
