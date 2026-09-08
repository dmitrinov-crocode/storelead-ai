import type { LeadCategory } from '../ai/agents/leadClassifier.js';

/**
 * What each lead category changes about the letter (task 5-02).
 *
 * The base prompt of 5-01 decides how the letter is written; this decides what
 * it is about. The two are separate because the tone rules never change — no
 * pitch, no flattery, 80–150 words — while the opening line has to be different
 * for a shop whose cart is broken and a shop that is merely slow.
 *
 * Two categories get no letter at all, and that is the most important entry in
 * the table. `HEALTHY_STORE` means the audit found little wrong; writing anyway
 * produces the letter that invents a problem to justify the contact, which is
 * the single failure this whole epic is built to avoid. `SKIP` is a code
 * decision from 3-09 — no shop, closed, too small — and there is nobody to
 * write to.
 */

export interface CategoryBrief {
  /** False means no letter is generated for this shop at all. */
  write: boolean;
  /** Reason, shown when a shop is passed over. */
  skipReason?: string;
  /** What the letter should lead with. Goes into the prompt verbatim. */
  angle?: string;
  /** The mistake this category invites. Also verbatim. */
  avoid?: string;
}

export const CATEGORY_BRIEFS: Record<LeadCategory, CategoryBrief> = {
  IDEAL_PROSPECT: {
    write: true,
    angle:
      'This shop can afford the work and has real, fixable problems. Lead with the single most ' +
      'costly thing you found and ask whether they already know about it.',
    avoid:
      'Do not list everything you found because there is a lot. One thing, named precisely, ' +
      'beats a survey.',
  },
  TECHNICAL_PROBLEMS: {
    write: true,
    angle:
      'Something is broken. Name the broken thing and the exact page it happens on, describe it ' +
      'the way a shopper would hit it, and ask if they have seen it.',
    avoid:
      'Do not name the underlying cause in technical terms. They do not need to hear about a ' +
      'JavaScript exception; they need to hear that add to cart does nothing on a phone.',
  },
  PERFORMANCE_PROBLEMS: {
    write: true,
    angle:
      'The shop is slow, and the mobile number is the story. Give the measurement and what it ' +
      'means for someone waiting on a phone.',
    avoid:
      'Do not promise a speed gain or a percentage. You have not looked at what is causing it ' +
      'yet, and a number you cannot stand behind is worse than no number.',
  },
  UX_PROBLEMS: {
    write: true,
    angle:
      'The shop works but is awkward. Describe the moment a shopper gets stuck — the tap that ' +
      'misses, the step that repeats — rather than naming a discipline.',
    avoid: 'Do not use the words "UX", "user experience" or "conversion funnel".',
  },
  REDESIGN_OPPORTUNITY: {
    write: true,
    angle:
      'The problem is the whole storefront, not one page. Mention what the theme age actually ' +
      'costs them and ask whether a rebuild is already on their list.',
    avoid:
      'Never say the shop looks old, dated or ugly. Somebody chose that design and may still be ' +
      'there. Ask about plans instead of judging the result.',
  },
  HIGH_REVENUE_LOW_QUALITY: {
    write: true,
    angle:
      'A storefront that does not match what the shop is doing. Lead with the gap between the ' +
      'catalogue they run and the problem you found.',
    avoid:
      'Never mention their revenue, traffic or growth. Those are third-party estimates, they are ' +
      'often wrong, and quoting a merchant their own numbers reads as surveillance.',
  },
  HEAVY_APP_STACK: {
    write: true,
    angle:
      'A lot of apps are loaded, and that is a plausible cause of what was measured. Put it as a ' +
      'question — apps are choices they made for reasons you do not know.',
    avoid: 'Do not tell them to remove apps. You have not checked what any of them earn.',
  },
  GROWING_STORE: {
    write: true,
    angle:
      'Growth is the notable fact. The finding is about what tends to break as a shop grows, so ' +
      'frame it as something to catch early rather than something already lost.',
    avoid:
      'Do not congratulate them and do not mention growth figures. Acknowledging momentum is ' +
      'fine; flattery is what marks the letter as bulk.',
  },
  HEALTHY_STORE: {
    write: false,
    skipReason: 'the audit found little wrong, and a letter would have to invent a reason to write',
  },
  SKIP: {
    write: false,
    skipReason: 'the shop was skipped by the code rules of 3-09',
  },
};

/** Whether the classifier's label is one this table actually knows. */
export function isKnownCategory(category: string): category is LeadCategory {
  return Object.hasOwn(CATEGORY_BRIEFS, category);
}

export function briefFor(category: LeadCategory): CategoryBrief {
  return CATEGORY_BRIEFS[category] ?? CATEGORY_BRIEFS.IDEAL_PROSPECT;
}

/** Categories a letter is written for. */
export function shouldWriteFor(category: LeadCategory): boolean {
  return briefFor(category).write;
}

/** The category brief as it appears in the prompt, or '' when there is none. */
export function renderBrief(category: LeadCategory): string {
  const brief = briefFor(category);
  if (!brief.write) return '';
  const lines: string[] = [];
  if (brief.angle) lines.push(`  ${brief.angle}`);
  if (brief.avoid) lines.push(`  Avoid: ${brief.avoid}`);
  return lines.join('\n');
}
