import { Buffer } from 'node:buffer';
import { analyzeApps } from '../analysis/apps.js';
import type { AppGroup, AppStackSize } from '../analysis/apps.js';
import type { SeoFacts, SiteSeoFacts } from '../audit/checks/seo.js';
import type { PageReport } from '../audit/auditStore.js';
import type { ViewportProfile } from '../audit/browser.js';
import type { KeyUrls } from '../audit/discovery.js';
import { PAGE_RANK, SEVERITY_RANK, type Evidence } from '../audit/issues.js';
import { getConfig } from '../config/index.js';
import type { Database } from '../db/client.js';
import { getAudit, getLatestAudit, listIssues } from '../db/repositories/audits.js';
import {
  getThemeInfo,
  listPagespeedResults,
  listStoreApps,
} from '../db/repositories/storeFacts.js';
import type {
  AuditIssueRow,
  AuditRow,
  IssueCategory,
  IssuePage,
  IssueSeverity,
  StoreRow,
} from '../db/types.js';
import type { AuditStatus } from '../pipeline/status.js';
import { nowIso } from '../lib/time.js';

/**
 * The fact bundle handed to the AI agents (task 3-01).
 *
 * Everything the model is allowed to reason about is assembled here, out of the
 * database only — audit findings, PageSpeed metrics, theme, apps and the
 * business numbers from StoreLeads. Two rules shape it:
 *
 *   - Every issue keeps its `audit_issues.id`. That id is the anchor the
 *     grounding guard (task 3-05) checks against, so a claim the model makes can
 *     always be traced back to something a check actually observed.
 *   - The bundle has a hard size ceiling. Prompts are paid for by the token, and
 *     one shop with 400 broken links must not cost fifty times what a healthy
 *     one costs. When the facts do not fit, they are cut in a fixed order — the
 *     cheapest evidence first, CRITICAL findings last — and what was cut is
 *     recorded in `meta`, so the model is never silently shown a tidier shop
 *     than the one that was audited.
 */

/** Bumped whenever the shape changes; travels with the prompt version (task 3-10). */
export const CONTEXT_VERSION = '1';

export interface ContextStore {
  id: number;
  domain: string;
  url: string;
  name: string | null;
  country: string | null;
  platform: string | null;
}

export interface ContextBusiness {
  rank: number | null;
  revenueEstimate: number | null;
  trafficEstimate: number | null;
  growthRate: number | null;
  productsCount: number | null;
  appsCount: number | null;
}

export interface ContextTheme {
  name: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  versionGap: number | null;
  ageMonths: number | null;
  architecture: string | null;
  freshness: string | null;
}

export interface ContextApps {
  /** How many apps StoreLeads counted, which can exceed the ones we have names for. */
  total: number | null;
  /** Stack size for this segment — see `analysis/apps.ts` for the calibration. */
  size: AppStackSize | null;
  /**
   * All nine groups plus `other`, zeros included: "no reviews app" is a finding,
   * and a key that is simply absent cannot be told apart from one we never checked.
   */
  byGroup: Record<AppGroup, number>;
  /** Categories outside the nine groups, largest first. */
  other?: { category: string; count: number }[];
  names?: string[];
}

export interface ContextPagespeed {
  strategy: 'mobile' | 'desktop';
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  speedIndexMs: number | null;
  fetchedAt: string;
}

export interface ContextIssue {
  /** `audit_issues.id` — what an AI issue must cite to survive the grounding guard. */
  id: number;
  page: IssuePage;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  detail?: string;
  evidence?: Evidence[];
  source: string;
}

export interface ContextPage {
  page: IssuePage;
  viewport: ViewportProfile;
  url: string | null;
  availability: PageReport['availability'];
  httpStatus: number | null;
  navigationMs: number | null;
  screenshotId: number | null;
  /** Kept even when the failure list is trimmed: silence must not read as success. */
  checks: { run: number; failed: number };
  failedChecks?: { name: string; error?: string }[];
  facts?: unknown;
}

export interface ContextAudit {
  id: number;
  status: AuditStatus;
  blocked: boolean;
  finishedAt: string | null;
  error: string | null;
  botProtection?: { vendor: string | null; signal: string | null };
  keyUrls?: { collection: string | null; product: string | null };
  /** Counted over every issue in the database, before any trimming. */
  counts: Record<IssueSeverity, number>;
  pages: ContextPage[];
  seo: { page: SeoFacts | null; site: SiteSeoFacts | null };
  issues: ContextIssue[];
}

export interface ContextMeta {
  maxBytes: number;
  /** True when the size limit cost the bundle some facts. */
  truncated: boolean;
  /** Names of the trim steps that were applied, in order. */
  trimmed: string[];
  /** Issues the audit found but this bundle does not carry. */
  issuesOmitted: number;
}

export interface StoreContext {
  version: string;
  generatedAt: string;
  store: ContextStore;
  business: ContextBusiness;
  theme: ContextTheme | null;
  apps: ContextApps | null;
  pagespeed: ContextPagespeed[];
  audit: ContextAudit | null;
  meta: ContextMeta;
}

export interface StoreContextBundle {
  context: StoreContext;
  /** What goes into the prompt: `context` with every null removed. */
  json: string;
  bytes: number;
  /** True when even the untrimmable core exceeds the budget — pathological, but visible. */
  overBudget: boolean;
}

export interface BuildContextOptions {
  db?: Database | undefined;
  /** Defaults to the store's latest audit. */
  auditId?: number | undefined;
  /** Defaults to `AI_CONTEXT_MAX_BYTES`. */
  maxBytes?: number | undefined;
}

export function buildStoreContext(
  store: StoreRow,
  options: BuildContextOptions = {},
): StoreContextBundle {
  const db = options.db;
  const maxBytes = options.maxBytes ?? getConfig().ai.contextMaxBytes;

  const audit =
    options.auditId === undefined ? getLatestAudit(store.id, db) : getAudit(options.auditId, db);

  const context: StoreContext = {
    version: CONTEXT_VERSION,
    generatedAt: nowIso(),
    store: {
      id: store.id,
      domain: store.domain,
      url: store.url,
      name: store.name,
      country: store.country,
      platform: store.platform,
    },
    business: {
      rank: store.rank,
      revenueEstimate: store.revenue_estimate,
      trafficEstimate: store.traffic_estimate,
      growthRate: store.growth_rate,
      productsCount: store.products_count,
      appsCount: store.apps_count,
    },
    theme: buildTheme(store, db),
    apps: buildApps(store, db),
    pagespeed: buildPagespeed(store.id, db),
    audit: audit ? buildAudit(audit, db) : null,
    meta: { maxBytes, truncated: false, trimmed: [], issuesOmitted: 0 },
  };

  return fit(context, maxBytes);
}

/**
 * The wire form: `null` means "we did not learn this", which is noise in a
 * prompt, so an absent key carries it instead. `false` and `0` are findings and
 * stay.
 */
export function serializeContext(context: StoreContext): string {
  return JSON.stringify(context, (_key, value: unknown) => (value === null ? undefined : value));
}

// ------------------------------------------------------------------ sections

function buildTheme(store: StoreRow, db: Database | undefined): ContextTheme | null {
  const row = getThemeInfo(store.id, db);
  // StoreLeads gives us a theme name even before the theme analysis step runs.
  if (!row && !store.theme_name && !store.theme_version) return null;
  return {
    name: row?.name ?? store.theme_name,
    currentVersion: row?.current_version ?? store.theme_version,
    latestVersion: row?.latest_version ?? null,
    versionGap: row?.version_gap ?? null,
    ageMonths: row?.age_months ?? null,
    architecture: row?.architecture ?? null,
    freshness: row?.freshness ?? null,
  };
}

function buildApps(store: StoreRow, db: Database | undefined): ContextApps | null {
  const rows = listStoreApps(store.id, db);
  if (rows.length === 0 && store.apps_count == null) return null;

  // Grouped here rather than read back from `app_stack`, so the bundle is right
  // even on a store the theme_apps step has not reached yet. Both paths run the
  // same function, so they cannot disagree (task 2-23).
  const analysis = analyzeApps(rows, { reportedCount: store.apps_count });

  return {
    total: store.apps_count ?? (rows.length || null),
    size: analysis.size,
    byGroup: analysis.byGroup,
    ...(analysis.otherCategories.length > 0 ? { other: analysis.otherCategories } : {}),
    ...(rows.length > 0 ? { names: rows.map((a) => a.name) } : {}),
  };
}

function buildPagespeed(storeId: number, db: Database | undefined): ContextPagespeed[] {
  // `raw_json` is deliberately left behind: it is a megabyte of Lighthouse audit
  // that no prompt has room for, and every metric worth reading is a column.
  return listPagespeedResults(storeId, db).map((row) => ({
    strategy: row.strategy,
    performance: row.performance,
    accessibility: row.accessibility,
    bestPractices: row.best_practices,
    seo: row.seo,
    fcpMs: row.fcp_ms,
    lcpMs: row.lcp_ms,
    cls: row.cls,
    inpMs: row.inp_ms,
    ttfbMs: row.ttfb_ms,
    speedIndexMs: row.speed_index_ms,
    fetchedAt: row.fetched_at,
  }));
}

/** What `auditStore` writes into `pages_json`; re-read defensively, it is TEXT. */
interface StoredPages {
  pages?: unknown;
  keyUrls?: KeyUrls | null;
  botProtection?: { vendor: string | null; signal: string | null } | null;
}

function buildAudit(audit: AuditRow, db: Database | undefined): ContextAudit {
  const issues = listIssues(audit.id, db);
  const stored = parseJson<StoredPages>(audit.pages_json);
  const seo = parseJson<{ page: SeoFacts | null; site: SiteSeoFacts | null }>(audit.seo_json);
  const pages = Array.isArray(stored?.pages) ? (stored.pages as PageReport[]) : [];
  const protection = stored?.botProtection;

  return {
    id: audit.id,
    status: audit.status,
    blocked: audit.blocked === 1,
    finishedAt: audit.finished_at,
    error: audit.error,
    ...(protection?.vendor ? { botProtection: protection } : {}),
    ...(stored?.keyUrls
      ? {
          keyUrls: {
            collection: stored.keyUrls.collection ?? null,
            product: stored.keyUrls.product ?? null,
          },
        }
      : {}),
    counts: countBySeverity(issues),
    pages: pages.map(toContextPage),
    seo: { page: seo?.page ?? null, site: seo?.site ?? null },
    // Worst first, so the budget's last-resort cut takes the least valuable end.
    issues: [...issues].sort(worstFirst).map(toContextIssue),
  };
}

function toContextPage(page: PageReport): ContextPage {
  const checks = Array.isArray(page.checks) ? page.checks : [];
  const failed = checks.filter((c) => c.status === 'failed');
  return {
    page: page.page,
    viewport: page.viewport,
    url: page.url ?? null,
    availability: page.availability,
    httpStatus: page.httpStatus ?? null,
    navigationMs: page.navigationMs ?? null,
    screenshotId: page.screenshotId ?? null,
    checks: { run: checks.length, failed: failed.length },
    ...(failed.length > 0
      ? {
          failedChecks: failed.map((c) => ({
            name: c.name,
            ...(c.error ? { error: c.error } : {}),
          })),
        }
      : {}),
    ...(page.facts == null ? {} : { facts: page.facts }),
  };
}

function toContextIssue(row: AuditIssueRow): ContextIssue {
  const evidence = parseJson<Evidence[]>(row.evidence_json);
  return {
    id: row.id,
    page: row.page,
    category: row.category,
    severity: row.severity,
    title: row.title,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(Array.isArray(evidence) && evidence.length > 0 ? { evidence } : {}),
    source: row.source,
  };
}

/** The reading order of a report: severity, then the order a shopper meets the pages. */
function worstFirst(a: AuditIssueRow, b: AuditIssueRow): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    PAGE_RANK[a.page] - PAGE_RANK[b.page] ||
    a.id - b.id
  );
}

function countBySeverity(issues: readonly AuditIssueRow[]): Record<IssueSeverity, number> {
  const counts: Record<IssueSeverity, number> = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A row written by an older schema is a missing fact, not a crashed step.
    return null;
  }
}

// --------------------------------------------------------------- size budget

/** Evidence records kept per issue at each of the two tightening steps. */
const TRIMMED_EVIDENCE = 2;
const MINIMUM_EVIDENCE = 1;

interface TrimStep {
  name: string;
  /** Returns true when it actually removed something. */
  apply: (context: StoreContext) => boolean;
}

/**
 * Ordered cheapest-first. Every step above `minor-issues` only shortens facts
 * the model can still infer from what remains; below it, findings start to
 * disappear and `meta` says so.
 */
const TRIM_STEPS: readonly TrimStep[] = [
  {
    // Per-page cart/checkout/link detail: useful, but restating what the issues say.
    name: 'page-facts',
    apply: (c) => eachPage(c, (p) => remove(p, 'facts')),
  },
  {
    name: 'app-names',
    apply: (c) => (c.apps ? remove(c.apps, 'names') : false),
  },
  {
    name: 'check-errors',
    apply: (c) =>
      eachPage(c, (p) => (p.failedChecks ?? []).map((f) => remove(f, 'error')).some(Boolean)),
  },
  {
    name: 'issue-detail',
    apply: (c) => eachIssue(c, (i) => (i.severity === 'CRITICAL' ? false : remove(i, 'detail'))),
  },
  {
    name: 'evidence',
    apply: (c) => capEvidence(c, TRIMMED_EVIDENCE),
  },
  {
    name: 'failed-checks',
    apply: (c) => eachPage(c, (p) => remove(p, 'failedChecks')),
  },
  {
    // The counts stay, so "12 MINOR issues, none listed" is still readable.
    name: 'minor-issues',
    apply: (c) => {
      if (!c.audit) return false;
      const kept = c.audit.issues.filter((i) => i.severity !== 'MINOR');
      if (kept.length === c.audit.issues.length) return false;
      c.meta.issuesOmitted += c.audit.issues.length - kept.length;
      c.audit.issues = kept;
      return true;
    },
  },
  {
    // A CRITICAL finding's prose is worth less than the finding itself, which
    // the tail cut below would otherwise take next.
    name: 'critical-detail',
    apply: (c) => eachIssue(c, (i) => remove(i, 'detail')),
  },
  {
    name: 'evidence-min',
    apply: (c) => capEvidence(c, MINIMUM_EVIDENCE),
  },
];

function capEvidence(context: StoreContext, keep: number): boolean {
  return eachIssue(context, (issue) => {
    if (!issue.evidence || issue.evidence.length <= keep) return false;
    issue.evidence = issue.evidence.slice(0, keep);
    return true;
  });
}

function fit(context: StoreContext, maxBytes: number): StoreContextBundle {
  let json = serializeContext(context);
  let bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= maxBytes) return { context, json, bytes, overBudget: false };

  const measure = () => {
    json = serializeContext(context);
    bytes = Buffer.byteLength(json, 'utf8');
  };

  for (const step of TRIM_STEPS) {
    if (!step.apply(context)) continue;
    context.meta.truncated = true;
    context.meta.trimmed.push(step.name);
    measure();
    if (bytes <= maxBytes) return { context, json, bytes, overBudget: false };
  }

  // Last resort: issues are sorted worst-first, so the tail is the cheapest loss.
  let dropped = 0;
  while (bytes > maxBytes && context.audit && context.audit.issues.length > 0) {
    if (dropped === 0) {
      // Stamped before the first cut, so every measurement below already pays for it.
      context.meta.truncated = true;
      context.meta.trimmed.push('issue-tail');
    }
    context.audit.issues.pop();
    context.meta.issuesOmitted += 1;
    dropped += 1;
    measure();
  }

  return { context, json, bytes, overBudget: bytes > maxBytes };
}

function eachPage(context: StoreContext, fn: (page: ContextPage) => boolean): boolean {
  // `.map().some()` rather than `.some()`: every page must be visited, not just
  // the ones before the first hit.
  return (context.audit?.pages ?? []).map(fn).some(Boolean);
}

function eachIssue(context: StoreContext, fn: (issue: ContextIssue) => boolean): boolean {
  return (context.audit?.issues ?? []).map(fn).some(Boolean);
}

function remove<T extends object, K extends keyof T>(target: T, key: K): boolean {
  if (!(key in target)) return false;
  delete target[key];
  return true;
}
