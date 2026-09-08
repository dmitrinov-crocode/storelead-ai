import type { StoreContext } from '../ai/context.js';

/**
 * Lead score, computed in code (task 3-08).
 *
 * The AI explains the lead; the number is arithmetic. Two reasons, both learned
 * the hard way in this kind of pipeline: a model asked for a score drifts
 * between runs on identical input, so nothing can be sorted or compared over
 * time; and a number nobody can decompose cannot be argued with when the
 * ranking looks wrong.
 *
 * What makes a good lead here is not a good shop. It is a shop worth money to
 * its owner that also has something visibly wrong with it — revenue and traffic
 * say the first, findings and performance say the second. A flawless shop and a
 * dying one are both poor leads, at opposite ends.
 *
 * Missing data is not zero. A shop StoreLeads has no revenue figure for has not
 * earned a low score, it has earned a narrower one: the weights of the signals
 * we do have are renormalised, and `coverage` reports how much of the total
 * weight was actually backed by data.
 */

export const LEAD_SCORE_MIN = 0;
export const LEAD_SCORE_MAX = 100;

/**
 * Weights sum to exactly 1. A perfect lead therefore scores exactly 100, which
 * a test pins: once the sum drifts above 1, every strong lead saturates at the
 * ceiling and stops being distinguishable from every other strong lead.
 */
export const LEAD_SCORE_WEIGHTS = {
  revenue: 0.25,
  issues: 0.25,
  traffic: 0.15,
  mobilePerformance: 0.15,
  growth: 0.1,
  themeAge: 0.1,
} as const;

export type LeadSignal = keyof typeof LEAD_SCORE_WEIGHTS;

export interface LeadScoreComponent {
  signal: LeadSignal;
  weight: number;
  /** 0..1 before weighting, or null when the input was not available. */
  value: number | null;
  /** The number the value came from, so a score can be explained. */
  basis: string;
}

export interface LeadScoreResult {
  score: number;
  components: LeadScoreComponent[];
  /** Share of the total weight that had data behind it, 0..1. */
  coverage: number;
}

/** Revenue in the segment: a one-person shop and a small brand, in PLN-ish USD. */
const REVENUE_FLOOR = 10_000;
const REVENUE_CEILING = 2_000_000;
/** Monthly visits. */
const TRAFFIC_FLOOR = 1_000;
const TRAFFIC_CEILING = 200_000;
/** Beyond this a theme is as old as it needs to be for the argument to land. */
const THEME_AGE_CEILING_MONTHS = 36;
/** Findings weighted by severity; above this the shop is as broken as it gets. */
const ISSUE_WEIGHT_CEILING = 20;
const SEVERITY_WEIGHT = { CRITICAL: 4, MAJOR: 2, MINOR: 0.5 } as const;

export function computeLeadScore(context: StoreContext): LeadScoreResult {
  const components: LeadScoreComponent[] = [
    revenueComponent(context),
    issuesComponent(context),
    trafficComponent(context),
    mobilePerformanceComponent(context),
    growthComponent(context),
    themeAgeComponent(context),
  ];

  let weighted = 0;
  let available = 0;
  for (const component of components) {
    if (component.value === null) continue;
    weighted += component.value * component.weight;
    available += component.weight;
  }

  // Renormalised over what we actually know, so a missing signal narrows the
  // evidence rather than dragging the score down.
  const score = available === 0 ? 0 : Math.round((weighted / available) * LEAD_SCORE_MAX);

  return {
    score: Math.min(LEAD_SCORE_MAX, Math.max(LEAD_SCORE_MIN, score)),
    components,
    coverage: available,
  };
}

/** Log scale: the step from 10k to 100k means far more than 1M to 1.1M. */
function logNormalise(value: number, floor: number, ceiling: number): number {
  if (value <= floor) return 0;
  if (value >= ceiling) return 1;
  return Math.log(value / floor) / Math.log(ceiling / floor);
}

function linearNormalise(value: number, floor: number, ceiling: number): number {
  if (value <= floor) return 0;
  if (value >= ceiling) return 1;
  return (value - floor) / (ceiling - floor);
}

function revenueComponent(context: StoreContext): LeadScoreComponent {
  const revenue = context.business.revenueEstimate;
  return {
    signal: 'revenue',
    weight: LEAD_SCORE_WEIGHTS.revenue,
    value: revenue === null ? null : logNormalise(revenue, REVENUE_FLOOR, REVENUE_CEILING),
    basis: revenue === null ? 'no revenue estimate' : `revenue ≈ ${revenue}`,
  };
}

function trafficComponent(context: StoreContext): LeadScoreComponent {
  const traffic = context.business.trafficEstimate;
  return {
    signal: 'traffic',
    weight: LEAD_SCORE_WEIGHTS.traffic,
    value: traffic === null ? null : logNormalise(traffic, TRAFFIC_FLOOR, TRAFFIC_CEILING),
    basis: traffic === null ? 'no traffic estimate' : `traffic ≈ ${traffic}`,
  };
}

/** Growth is a tie-breaker: a shrinking shop is not disqualified, just quieter. */
function growthComponent(context: StoreContext): LeadScoreComponent {
  const growth = context.business.growthRate;
  return {
    signal: 'growth',
    weight: LEAD_SCORE_WEIGHTS.growth,
    // -20%..+50% mapped onto 0..1; the band is where this segment actually sits.
    value: growth === null ? null : linearNormalise(growth, -0.2, 0.5),
    basis: growth === null ? 'no growth figure' : `growth ${(growth * 100).toFixed(1)}%`,
  };
}

/**
 * More and worse findings make a better lead, up to a point: past the ceiling
 * the shop is not more broken, it is only more tediously broken.
 */
function issuesComponent(context: StoreContext): LeadScoreComponent {
  const counts = context.audit?.counts;
  if (!counts || context.audit?.blocked) {
    return {
      signal: 'issues',
      weight: LEAD_SCORE_WEIGHTS.issues,
      value: null,
      basis: context.audit?.blocked ? 'audit blocked, findings unknown' : 'no audit',
    };
  }
  const weight =
    counts.CRITICAL * SEVERITY_WEIGHT.CRITICAL +
    counts.MAJOR * SEVERITY_WEIGHT.MAJOR +
    counts.MINOR * SEVERITY_WEIGHT.MINOR;
  return {
    signal: 'issues',
    weight: LEAD_SCORE_WEIGHTS.issues,
    value: Math.min(1, weight / ISSUE_WEIGHT_CEILING),
    basis: `${counts.CRITICAL} critical, ${counts.MAJOR} major, ${counts.MINOR} minor`,
  };
}

/** A slow phone experience is the easiest problem to open a conversation with. */
function mobilePerformanceComponent(context: StoreContext): LeadScoreComponent {
  const mobile = context.pagespeed.find((row) => row.strategy === 'mobile');
  const performance = mobile?.performance ?? null;
  return {
    signal: 'mobilePerformance',
    weight: LEAD_SCORE_WEIGHTS.mobilePerformance,
    // Inverted: 0/100 performance is the strongest possible reason to call.
    value: performance === null ? null : 1 - performance / 100,
    basis: performance === null ? 'no mobile PageSpeed' : `mobile performance ${performance}`,
  };
}

function themeAgeComponent(context: StoreContext): LeadScoreComponent {
  const age = context.theme?.ageMonths ?? null;
  return {
    signal: 'themeAge',
    weight: LEAD_SCORE_WEIGHTS.themeAge,
    value: age === null ? null : Math.min(1, age / THEME_AGE_CEILING_MONTHS),
    basis: age === null ? 'theme age unknown' : `theme ${age} months old`,
  };
}

/** One line per signal, for the classifier's prompt and for the dashboard. */
export function explainLeadScore(result: LeadScoreResult): string[] {
  return result.components.map(
    (c) =>
      `${c.signal} (weight ${c.weight}): ` +
      (c.value === null
        ? `not scored — ${c.basis}`
        : `${Math.round(c.value * 100)}/100 — ${c.basis}`),
  );
}
