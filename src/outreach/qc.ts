import { z } from 'zod';
import type { AiClient } from '../ai/client.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import type { LeadCategory } from '../ai/agents/leadClassifier.js';
import { promptHash } from '../ai/agents/storeAnalyst.js';
import { briefFor } from './categories.js';
import { renderFactSheet, type Fact } from './facts.js';
import { WORD_RANGE, firstName } from './prompt.js';

/**
 * The QC agent (task 5-04).
 *
 * Seven checks, as the plan lists them — but they are not all asked of the
 * model, and the split is deliberate. Length and repetition are arithmetic: a
 * word count is a number and a similarity score is a number, and handing either
 * to a model invites it to be diplomatic about a fact. Those two arrive here
 * already decided, from 5-05 and 5-07, and are reported alongside the rest so
 * the verdict a human reads covers all seven in one place.
 *
 * The model judges the four that are genuinely judgement: whether every claim
 * traces to a fact it was given, whether the letter is about this shop or could
 * be sent to any shop, whether it matches why this shop was a lead, and whether
 * it reads like a person or like outreach.
 *
 * The reviewer sees the same fact sheet the writer did and nothing else. That is
 * what makes the facts check possible at all — asked to verify a letter against
 * a shop it cannot see, a model can only guess, and it will guess PASS.
 *
 * Any single FAIL fails the letter. A QC that weighs its checks against each
 * other ends up passing a letter with an invented claim because the tone was
 * good, and an invented claim is the one thing that must never go out.
 */

export const QC_AGENT = 'outreach_qc';
export const QC_PROMPT_VERSION = '1';

export const QC_VERDICTS = ['PASS', 'FAIL'] as const;
export type QcVerdict = (typeof QC_VERDICTS)[number];

/** The four the model decides, in the order the prompt asks for them. */
export const MODEL_CHECKS = ['facts', 'personalisation', 'category', 'tone'] as const;
export type ModelCheckName = (typeof MODEL_CHECKS)[number];

/** Every check in the report, including the two decided in code. */
export type QcCheckName = ModelCheckName | 'pushiness' | 'length' | 'repetition';

const checkSchema = z.object({
  verdict: z.enum(QC_VERDICTS),
  reason: z.string().min(1),
});

export const qcOutputSchema = z.object({
  facts: checkSchema,
  personalisation: checkSchema,
  category: checkSchema,
  tone: checkSchema,
  pushiness: checkSchema,
});

export type QcOutput = z.infer<typeof qcOutputSchema>;

export const QC_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['facts', 'personalisation', 'category', 'tone', 'pushiness'],
  properties: Object.fromEntries(
    [
      ['facts', 'Does every claim about the shop trace to a fact on the sheet?'],
      ['personalisation', 'Could this letter be sent unchanged to another shop?'],
      ['category', 'Does the letter match why this shop was a lead?'],
      ['tone', 'Does it read like a person writing, or like outreach?'],
      ['pushiness', 'Does it sell, offer, or ask for a call?'],
    ].map(([name, description]) => [
      name,
      {
        type: 'object',
        additionalProperties: false,
        required: ['verdict', 'reason'],
        properties: {
          verdict: { type: 'string', enum: [...QC_VERDICTS] },
          reason: { type: 'string', description: `${description} Say why, in one sentence.` },
        },
      },
    ]),
  ),
};

export const QC_SYSTEM_PROMPT = `You review a cold email before a human sees it. You are the last
check between a draft and a shop owner's inbox.

You are given the email, the fact sheet its writer was allowed to use, and why the shop was a lead.
You cannot see the shop. That is on purpose: if a claim is not on the sheet, you have no way to
confirm it, and neither will the merchant — except they will know it is wrong.

Judge these five, independently. Do not trade one off against another.

  facts           Every statement about the shop must trace to a fact on the sheet. A claim that
                  goes further than its fact is a FAIL — "your checkout is broken" is not supported
                  by a fact about the cart page. Rephrasing a fact in plainer words is fine.
                  What the sender says they themselves did is not a claim about the shop and needs
                  no fact: "I looked at your shop", "I checked the cart on a phone", naming the shop
                  or its address. Judge only what the email asserts about the storefront.
  personalisation Could this be sent unchanged to a different shop? If yes, FAIL. Naming the shop
                  is not personalisation; naming what was found on it is.
  category        The email must be about the reason this shop was a lead. A letter about slow
                  loading for a shop flagged for a broken cart is a FAIL.
  tone            Plain, direct, human. FAIL flattery, hype, filler openings, and anything that
                  reads as written to a list rather than to a person.
  pushiness       This email sells nothing. FAIL any offer, price, service list, case study,
                  calendar link, or request for a call. Asking a question is not pushy; asking for
                  their time is.

Rules:

1. Judge only what is in front of you. Never assume a fact is true because it sounds plausible.
2. A single FAIL fails the email. Do not soften a verdict because the rest was good.
3. Every reason must name the specific words that decided it. "Tone is off" is not a reason;
   "opens with 'I hope this finds you well'" is.
4. PASS is a real answer. A correct, plain, grounded email should pass all five.`;

export interface QcCheckResult {
  name: QcCheckName;
  verdict: QcVerdict | 'NOT_CHECKED';
  reason: string;
}

export interface QcReport {
  /** True only when every check that ran passed. */
  passed: boolean;
  checks: QcCheckResult[];
  /** Reasons of the failed checks, ready for the regeneration loop of 5-06. */
  failures: string[];
  promptVersion: string;
  promptHash: string;
  usage: {
    tokensIn: number | null;
    tokensOut: number | null;
    durationMs: number;
    model: string;
  } | null;
  rawText: string | null;
}

export interface ReviewEmailOptions {
  client: AiClient;
  subject: string;
  body: string;
  /** The same sheet the writer was given — see the note at the top. */
  facts: readonly Fact[];
  category: LeadCategory;
  contactName?: string | null;
  /** Decided by 5-05; passed through so the report covers all seven checks. */
  length?: { wordCount: number; passed: boolean } | undefined;
  /** Decided by 5-07. Omitted until the detector exists. */
  repetition?: { similarity: number; threshold: number } | undefined;
  attempts?: number;
  logger?: Logger;
  signal?: AbortSignal | undefined;
}

export async function reviewEmail(options: ReviewEmailOptions): Promise<QcReport> {
  const logger = options.logger ?? silentLogger();
  const attempts = options.attempts ?? 2;
  const user = buildQcPrompt(options);
  const hash = promptHash(QC_SYSTEM_PROMPT, user);

  let lastError: unknown;
  let lastText = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await options.client.complete({
      system: QC_SYSTEM_PROMPT,
      user:
        attempt === 1
          ? user
          : `${user}\n\nYour previous answer was rejected: ${String(lastError)}. Answer again with JSON matching the schema exactly.`,
      schemaName: 'outreach_qc',
      jsonSchema: QC_JSON_SCHEMA,
      signal: options.signal,
    });

    lastText = result.text;
    let parsed: QcOutput;
    try {
      parsed = qcOutputSchema.parse(JSON.parse(result.text));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn({ attempt, err: lastError }, 'QC answer did not fit the schema');
      continue;
    }

    const checks: QcCheckResult[] = [
      ...(Object.keys(parsed) as (keyof QcOutput)[]).map((name) => ({
        name: name,
        verdict: parsed[name].verdict,
        reason: parsed[name].reason,
      })),
      lengthCheck(options.length),
      repetitionCheck(options.repetition),
    ];

    return finish(checks, {
      promptVersion: `${QC_PROMPT_VERSION}`,
      promptHash: hash,
      usage: {
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs: result.durationMs,
        model: result.model,
      },
      rawText: result.text,
    });
  }

  // A reviewer that cannot answer must not be read as approval: the letter is
  // failed on the QC itself, and the reason says so rather than blaming the draft.
  logger.warn({ err: lastError }, 'the QC agent did not answer; failing the draft');
  return finish(
    [
      {
        name: 'facts',
        verdict: 'FAIL',
        reason: `The QC agent did not return a usable verdict in ${attempts} attempts.`,
      },
      lengthCheck(options.length),
      repetitionCheck(options.repetition),
    ],
    { promptVersion: QC_PROMPT_VERSION, promptHash: hash, usage: null, rawText: lastText },
  );
}

function finish(
  checks: QcCheckResult[],
  rest: Omit<QcReport, 'passed' | 'checks' | 'failures'>,
): QcReport {
  const failed = checks.filter((check) => check.verdict === 'FAIL');
  return {
    passed: failed.length === 0,
    checks,
    failures: failed.map((check) => `${check.name}: ${check.reason}`),
    ...rest,
  };
}

function lengthCheck(length: ReviewEmailOptions['length']): QcCheckResult {
  if (!length) {
    return { name: 'length', verdict: 'NOT_CHECKED', reason: 'no word count was supplied' };
  }
  return {
    name: 'length',
    verdict: length.passed ? 'PASS' : 'FAIL',
    reason: `${length.wordCount} words (${WORD_RANGE.min}–${WORD_RANGE.max} allowed)`,
  };
}

function repetitionCheck(repetition: ReviewEmailOptions['repetition']): QcCheckResult {
  if (!repetition) {
    return {
      name: 'repetition',
      verdict: 'NOT_CHECKED',
      reason: 'the repetition detector of 5-07 did not run',
    };
  }
  const similar = repetition.similarity >= repetition.threshold;
  return {
    name: 'repetition',
    verdict: similar ? 'FAIL' : 'PASS',
    reason: `${(repetition.similarity * 100).toFixed(0)}% similar to an earlier letter (threshold ${(repetition.threshold * 100).toFixed(0)}%)`,
  };
}

export function buildQcPrompt(options: ReviewEmailOptions): string {
  const brief = briefFor(options.category);
  const greeting = firstName(options.contactName);

  return [
    `Why the shop was a lead: ${options.category}`,
    brief.angle ? `What the letter was asked to lead with: ${brief.angle}` : '',
    greeting
      ? `The contact is called ${greeting}; the letter was asked to open with that name.`
      : 'No contact was named, so the letter was asked not to use a first name.',
    '',
    'Facts the writer was allowed to use, and nothing else:',
    renderFactSheet(options.facts),
    '',
    '--- the email ---',
    `Subject: ${options.subject}`,
    '',
    options.body,
    '--- end ---',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
