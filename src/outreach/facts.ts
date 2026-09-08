import type { StoreContext } from '../ai/context.js';
import type { StoreAnalystOutput } from '../ai/agents/storeAnalyst.js';

/**
 * The fact sheet a letter may draw on (tasks 5-01, 5-05).
 *
 * This is the grounding guard of 3-05, moved one step further down the pipeline
 * and made stricter, because the stakes are higher. An invented finding in an
 * internal analysis is a bad row in a dashboard; an invented finding in a letter
 * is a false claim sent to a merchant about their own shop, over our name. They
 * know their storefront better than we do, and one wrong sentence ends the
 * conversation.
 *
 * So the model is never handed the raw context and asked to write. It is handed
 * a numbered sheet of facts that came out of the database, and it must return
 * the ids of the ones it used. Anything it cites that is not on the sheet is
 * dropped, and a letter left with no fact at all does not go out.
 *
 * Ids are short and stable — `A12` for audit issue 12, `P1` for the first
 * PageSpeed row — so they survive the round trip through the model intact and
 * are readable when a human checks a draft against them.
 */

export type FactKind = 'issue' | 'pagespeed' | 'theme' | 'apps' | 'business';

export interface Fact {
  /** Short handle the model cites: `A12`, `P1`, `T1`. */
  id: string;
  kind: FactKind;
  /** One line, in the merchant's terms. This is what the letter may say. */
  text: string;
  /** Where it came from, for a human checking the draft. */
  source: string;
}

/** Severity order for picking which findings are worth a letter. */
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, MAJOR: 1, MINOR: 2 };

/**
 * How many facts the sheet may carry.
 *
 * A short list is not a budget concern — it is the point. A letter of 80 to 150
 * words can carry two or three concrete things; offering the model thirty
 * invites it to write a list, and a list is the kind of letter nobody answers.
 */
export const MAX_FACTS = 12;

export interface BuildFactSheetOptions {
  context: StoreContext;
  /** The analyst's reading, when the analysis step produced one. */
  analysis?: StoreAnalystOutput | undefined;
  maxFacts?: number;
}

/**
 * The facts one shop offers, most useful to a letter first.
 *
 * Ordering is deliberate. The analyst's issues come first because they are
 * already phrased as an impact on the merchant, then measurements, then the
 * slower-moving context — a theme's age or an app count is background, not a
 * reason to write.
 */
export function buildFactSheet(options: BuildFactSheetOptions): Fact[] {
  const { context, analysis } = options;
  const limit = options.maxFacts ?? MAX_FACTS;
  const facts: Fact[] = [];

  // The analyst's issues, already grounded in audit findings by 3-05.
  const issues = [...(analysis?.issues ?? [])].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  );
  for (const issue of issues) {
    facts.push({
      id: `A${issue.evidenceId}`,
      kind: 'issue',
      text: `${issue.title} (${issue.page}) — ${issue.impact}`,
      source: `audit finding ${issue.evidenceId}, ${issue.severity}`,
    });
  }

  // Measurements. Mobile first: it is where these shops lose money, and the
  // number a merchant can check for themselves in ten seconds.
  const pagespeed = [...context.pagespeed].sort((a, b) =>
    a.strategy === b.strategy ? 0 : a.strategy === 'mobile' ? -1 : 1,
  );
  pagespeed.forEach((row, index) => {
    const parts: string[] = [];
    if (row.performance !== null) parts.push(`performance ${row.performance}/100`);
    if (row.lcpMs !== null) parts.push(`largest paint ${(row.lcpMs / 1000).toFixed(1)}s`);
    if (row.cls !== null) parts.push(`layout shift ${row.cls}`);
    if (parts.length === 0) return;
    facts.push({
      id: `P${index + 1}`,
      kind: 'pagespeed',
      text: `PageSpeed on ${row.strategy}: ${parts.join(', ')}`,
      source: `PageSpeed Insights, ${row.strategy}`,
    });
  });

  if (context.theme && context.theme.name) {
    const age =
      context.theme.ageMonths !== null && context.theme.ageMonths !== undefined
        ? `, about ${context.theme.ageMonths} months behind the current release`
        : '';
    facts.push({
      id: 'T1',
      kind: 'theme',
      text: `The storefront runs the ${context.theme.name} theme${age}`,
      source: 'theme detection',
    });
  }

  if (context.apps?.total !== null && context.apps?.total !== undefined && context.apps.total > 0) {
    const bucket = context.apps.size ? ` — a ${context.apps.size} stack for this segment` : '';
    facts.push({
      id: 'S1',
      kind: 'apps',
      text: `${context.apps.total} Shopify apps are loaded on the storefront${bucket}`,
      source: 'app stack detection',
    });
  }

  if (context.business.productsCount !== null && context.business.productsCount !== undefined) {
    facts.push({
      id: 'B1',
      kind: 'business',
      text: `The catalogue lists ${context.business.productsCount} products`,
      source: 'StoreLeads',
    });
  }

  return facts.slice(0, limit);
}

/** Renders the sheet for the prompt, one fact per line, id first. */
export function renderFactSheet(facts: readonly Fact[]): string {
  if (facts.length === 0) return '  (no facts were gathered for this shop)';
  return facts.map((fact) => `  [${fact.id}] ${fact.text}`).join('\n');
}

export interface GroundingResult {
  /** Cited ids that exist on the sheet. */
  used: Fact[];
  /** Cited ids that do not — the model made them up. */
  invented: string[];
}

/**
 * Checks what a letter claims to have used against what it was offered.
 *
 * Unknown ids are not an error to retry on their own: the letter may still be
 * perfectly good and merely have mislabelled its sources. What matters is what
 * survives — `used` being empty is the failure, and 5-05 is where that is
 * turned into a verdict.
 */
export function applyFactGuard(facts: readonly Fact[], cited: readonly string[]): GroundingResult {
  const byId = new Map(facts.map((fact) => [fact.id.toUpperCase(), fact]));
  const used: Fact[] = [];
  const invented: string[] = [];
  const seen = new Set<string>();

  for (const raw of cited) {
    const id = raw.trim().toUpperCase();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const fact = byId.get(id);
    if (fact) used.push(fact);
    else invented.push(raw.trim());
  }

  return { used, invented };
}
