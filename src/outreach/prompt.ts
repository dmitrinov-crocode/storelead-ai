import type { StoreContext } from '../ai/context.js';
import type { LeadCategory } from '../ai/agents/leadClassifier.js';
import { renderBrief } from './categories.js';
import { renderFactSheet, type Fact } from './facts.js';

/**
 * The base outreach prompt (task 5-01).
 *
 * The brief from the plan, in one line: a first email whose only job is to get a
 * reply. Not to sell, not to pitch a package, not to book a call. That single
 * constraint is what most of the rules below are protecting, because every
 * instinct a language model has about "write a business email" pulls the other
 * way — towards a value proposition, a list of services and a closing ask for
 * thirty minutes.
 *
 * Length is 80–150 words and it is enforced twice: asked for here, and measured
 * in code by 5-05. A model asked for a word count will miss it, and a letter of
 * 300 words is a different genre from the one that gets answered.
 *
 * The letter may only use facts from the sheet (see `facts.ts`), and must name
 * the ones it used. That is not bookkeeping — it is what lets a human check a
 * draft in ten seconds, and what stops a model filling a thin shop with
 * plausible-sounding problems.
 */

export const OUTREACH_AGENT = 'outreach';
export const OUTREACH_PROMPT_VERSION = '1';

/** The window 5-05 enforces. Stated here so the prompt and the check cannot drift. */
export const WORD_RANGE = { min: 80, max: 150 } as const;

export const OUTREACH_SYSTEM_PROMPT = `You write the first email to the owner of a Shopify shop, on
behalf of a small agency that fixes storefronts. You are not selling anything in this email.

Your only goal is a reply. A merchant who writes back "which page?" is a success. A merchant who
reads a pitch and does not answer is a failure, however polished the pitch was.

Write it like this:

1. ${WORD_RANGE.min}–${WORD_RANGE.max} words. Count them. Anything longer reads as a sales letter
   and is deleted.
2. Use only the facts on the sheet you are given. Never add a problem, a number, a competitor or a
   guess about their business. If the sheet is thin, write a shorter, plainer email — do not pad it.
3. Two concrete things at most. One is often better. A list of findings is a report, not a letter,
   and nobody answers a report.
4. Say what you saw and where you saw it, in the merchant's terms: what it costs them, not what it
   is called. "Add to cart does nothing on mobile" — not "a JavaScript exception in the cart handler".
5. No offer, no price, no services, no case studies, no calendar link, no "quick call". End with a
   question they can answer in one line.
6. Plain language. No "I hope this email finds you well", no "I wanted to reach out", no "game
   changer", no "leverage", no "solutions". Do not flatter the shop.
7. If a first name is given, open with it. If not, do not invent one and do not write "Dear Owner" —
   open with the shop instead.
8. Write in the language named in the brief.

The subject line is at most 60 characters, lower-case, and says the specific thing you found. Not
"Improving your store" — something a merchant would open because it names their own shop's problem.

Return the ids of every fact you used. Use only ids that appear on the sheet.`;

export const OUTREACH_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body', 'factsUsed'],
  properties: {
    subject: {
      type: 'string',
      description: 'At most 60 characters, lower-case, naming the specific finding.',
    },
    body: {
      type: 'string',
      description: `The email itself, ${WORD_RANGE.min}–${WORD_RANGE.max} words, no signature block.`,
    },
    factsUsed: {
      type: 'array',
      description: 'Ids from the fact sheet, exactly as written there. Never invent one.',
      items: { type: 'string' },
    },
  },
};

export interface OutreachPromptInput {
  context: StoreContext;
  facts: readonly Fact[];
  category: LeadCategory;
  /** Reason the classifier gave, so the letter opens on what made this a lead. */
  categoryReason?: string | null;
  /** First name of the contact, when one was found. */
  contactName?: string | null;
  contactRole?: string | null;
  /** Language to write in, as a plain word the model understands. */
  language?: string;
  /** Appended on a retry, naming what was wrong with the previous attempt. */
  feedback?: string | null;
}

/** Polish shops get Polish letters; everything else falls back to English. */
export function languageFor(country: string | null | undefined): string {
  return (country ?? '').toUpperCase() === 'PL' ? 'Polish' : 'English';
}

/** `Anna Kowalska` -> `Anna`. A first line is a greeting, not an address label. */
export function firstName(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first.length >= 2 ? first : null;
}

export function buildOutreachPrompt(input: OutreachPromptInput): string {
  const { context, facts, category } = input;
  const greeting = firstName(input.contactName);

  const lines: string[] = [
    `Shop: ${context.store.name ?? context.store.domain} (${context.store.domain})`,
    `Write in: ${input.language ?? languageFor(context.store.country)}`,
    greeting
      ? `Write to: ${greeting}${input.contactRole ? `, ${input.contactRole}` : ''}`
      : 'Write to: nobody was named — open with the shop, do not invent a name',
    '',
    `Why this shop is a lead: ${category}${input.categoryReason ? ` — ${input.categoryReason}` : ''}`,
  ];

  // The angle for this category (task 5-02). The tone rules never change; what
  // the letter opens on does.
  const brief = renderBrief(category);
  if (brief !== '') lines.push('', 'How to approach this one:', brief);

  lines.push(
    '',
    'Facts you may use. Cite the ids of the ones you use, and use nothing else:',
    renderFactSheet(facts),
  );

  if (input.feedback) {
    lines.push(
      '',
      'Your previous draft was rejected. Fix exactly this and keep everything that was fine:',
      `  ${input.feedback}`,
    );
  }

  return lines.join('\n');
}
