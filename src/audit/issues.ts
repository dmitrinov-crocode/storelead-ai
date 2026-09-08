import type { IssueCategory, IssuePage, IssueSeverity } from '../db/types.js';
import type { ViewportProfile } from './browser.js';

/**
 * The single shape every finding takes (task 2-05).
 *
 * The rule the whole project rests on: no issue without evidence. Every check
 * produces `Issue` objects carrying what was observed — a selector, an error
 * text, an HTTP status, a screenshot id — so the outreach email can quote a fact
 * rather than an opinion.
 */

export const SEVERITIES: readonly IssueSeverity[] = ['CRITICAL', 'MAJOR', 'MINOR'];

/** Lower sorts first: CRITICAL before MAJOR before MINOR. */
export const SEVERITY_RANK: Record<IssueSeverity, number> = {
  CRITICAL: 0,
  MAJOR: 1,
  MINOR: 2,
};

/** Reading order of a shopping session, used to sort a report. */
export const PAGE_RANK: Record<IssuePage, number> = {
  site: 0,
  homepage: 1,
  collection: 2,
  product: 3,
  cart: 4,
  checkout: 5,
};

export type IssueSource = 'playwright' | 'pagespeed' | 'ai';

/** All fields optional: a check attaches whatever it actually observed. */
export interface Evidence {
  /** CSS selector of the offending element. */
  selector?: string;
  /** Verbatim console message, element text or error string. */
  text?: string;
  /** URL the evidence belongs to: the page, or the failing resource. */
  url?: string;
  /** HTTP status observed for `url`. */
  status?: number;
  /** Row id in `screenshots`, so the report can show the proof. */
  screenshotId?: number;
  viewport?: ViewportProfile;
  /** What the check expected versus what it found. */
  expected?: string;
  actual?: string;
  /** How many times the same thing was observed. */
  count?: number;
}

export interface Issue {
  page: IssuePage;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  detail?: string;
  evidence: Evidence[];
  source: IssueSource;
}

export interface IssueInput {
  page: IssuePage;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  detail?: string;
  /** One record or several; a single object is the common case. */
  evidence?: Evidence | Evidence[];
  source?: IssueSource;
}

const MAX_TITLE = 200;
const MAX_DETAIL = 2000;
const MAX_TEXT = 500;
/** An issue quoting 200 selectors helps nobody; the count carries the scale. */
export const MAX_EVIDENCE = 10;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Drops empty fields so `evidence_json` never stores `{"selector": null}`. */
export function normalizeEvidence(evidence: Evidence): Evidence {
  const out: Evidence = {};
  if (evidence.selector) out.selector = truncate(evidence.selector, MAX_TEXT);
  if (evidence.text) out.text = truncate(evidence.text, MAX_TEXT);
  if (evidence.url) out.url = truncate(evidence.url, MAX_TEXT);
  if (typeof evidence.status === 'number') out.status = evidence.status;
  if (typeof evidence.screenshotId === 'number') out.screenshotId = evidence.screenshotId;
  if (evidence.viewport) out.viewport = evidence.viewport;
  if (evidence.expected) out.expected = truncate(evidence.expected, MAX_TEXT);
  if (evidence.actual) out.actual = truncate(evidence.actual, MAX_TEXT);
  if (typeof evidence.count === 'number' && evidence.count > 1) out.count = evidence.count;
  return out;
}

export function createIssue(input: IssueInput): Issue {
  const title = input.title.trim();
  if (!title) throw new Error('An issue must have a title');

  const list = input.evidence === undefined ? [] : flatten(input.evidence);
  const evidence = list.map(normalizeEvidence).filter((e) => Object.keys(e).length > 0);

  return {
    page: input.page,
    category: input.category,
    severity: input.severity,
    title: truncate(title, MAX_TITLE),
    ...(input.detail ? { detail: truncate(input.detail, MAX_DETAIL) } : {}),
    evidence: evidence.slice(0, MAX_EVIDENCE),
    source: input.source ?? 'playwright',
  };
}

function flatten(evidence: Evidence | Evidence[]): Evidence[] {
  return Array.isArray(evidence) ? evidence : [evidence];
}

/**
 * Two checks can reach the same conclusion — a broken image is both a failed
 * request and a DOM-level failure. They are merged rather than reported twice,
 * keeping the union of the evidence and the harsher severity.
 */
export function dedupeIssues(issues: readonly Issue[]): Issue[] {
  const byKey = new Map<string, Issue>();
  for (const issue of issues) {
    const key = `${issue.page}|${issue.category}|${issue.title}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...issue, evidence: [...issue.evidence] });
      continue;
    }
    if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[existing.severity]) {
      existing.severity = issue.severity;
    }
    for (const record of issue.evidence) {
      const seen = existing.evidence.some((e) => JSON.stringify(e) === JSON.stringify(record));
      if (!seen && existing.evidence.length < MAX_EVIDENCE) existing.evidence.push(record);
    }
    if (!existing.detail && issue.detail) existing.detail = issue.detail;
  }
  return [...byKey.values()];
}

/** Worst first, then in the order a shopper meets the pages. */
export function sortIssues(issues: readonly Issue[]): Issue[] {
  return [...issues].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      PAGE_RANK[a.page] - PAGE_RANK[b.page] ||
      a.title.localeCompare(b.title),
  );
}

export function countBySeverity(issues: readonly Issue[]): Record<IssueSeverity, number> {
  const counts: Record<IssueSeverity, number> = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}
