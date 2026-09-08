// Server-only: this module opens the SQLite file directly and must never be
// imported from a client component.
import { connection } from "next/server";
import { databaseReady, queryAll, queryOne, type SqlParam } from "./db";
import { paginate, type PageInfo } from "./pagination";
import { buildOrderBy, type SortDirection, type SortKey } from "./sorting";
import { activeLock, type LockInfo } from "./pipelineLock";
import type { RunRow, StoreRow } from "@core/db/types";
import type { ApprovedLetter } from "./csvExport";

export interface StoreListItem extends StoreRow {
  category: string | null;
  lead_score: number | null;
  critical_issues: number;
  major_issues: number;
  email_status: string | null;
  /** Epic 4 columns: a person to write to, a person to look up, a shared inbox. */
  contact_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  contact_confidence: number | null;
  contact_linkedin: string | null;
  /** Space-separated, in the order 4-08 ranked them. */
  generic_emails: string | null;
  generic_count: number;
}

export interface DashboardData {
  ready: boolean;
  runs: RunRow[];
  runsPage: PageInfo;
  stores: StoreListItem[];
  storesPage: PageInfo;
  /** Distinct statuses actually present, so the legend can dim the rest. */
  runStatuses: Set<string>;
  storeStatuses: Set<string>;
  /** Categories the classifier has actually produced, for the filter's options. */
  storeCategories: string[];
  /** Held while a pipeline run is in progress, so the UI can poll and disable actions. */
  running: LockInfo | null;
  /** How many letters a human has approved — what the CSV export of 6-09 holds. */
  approved: number;
}

export interface StoreFilters {
  domain?: string;
  rankMin?: number;
  rankMax?: number;
  scoreMin?: number;
  scoreMax?: number;
  revenueMin?: number;
  revenueMax?: number;
  issuesMin?: number;
  issuesMax?: number;
  status?: string;
  email?: string;
  /** Lead category from 3-07. */
  category?: string;
  /** `CRITICAL` or `MAJOR`: the store has at least one finding of that severity. */
  severity?: string;
}

export interface DashboardQuery {
  runsPage: number;
  storesPage: number;
  pageSize: number;
  storesPageSize: number;
  sort: SortKey;
  direction: SortDirection;
  filters?: StoreFilters;
}

const DATA_DIR = process.env.STORELEAD_DATA_DIR;

/**
 * Whether a pipeline is running right now. Read from the lock rather than from
 * a RUNNING row, because a killed run never clears its row.
 */
export function runningPipeline(): LockInfo | null {
  return DATA_DIR ? activeLock(DATA_DIR) : null;
}

function count(sql: string): number {
  return queryOne<{ n: number }>(sql)?.n ?? 0;
}

function distinct(sql: string): Set<string> {
  return new Set(queryAll<{ value: string }>(sql).map((row) => row.value));
}

function storeFrom(): string {
  return `
    FROM stores s
    LEFT JOIN (
      SELECT store_id, category, lead_score,
             ROW_NUMBER() OVER (
               PARTITION BY store_id
               ORDER BY id DESC
             ) AS rn
        FROM ai_analyses
       WHERE agent = 'lead_classifier'
    ) a ON a.store_id = s.id AND a.rn = 1

    LEFT JOIN (
      SELECT store_id,
             SUM(severity = 'CRITICAL') AS critical_issues,
             SUM(severity = 'MAJOR') AS major_issues
        FROM audit_issues
       GROUP BY store_id
    ) i ON i.store_id = s.id

    LEFT JOIN (
      SELECT store_id, status,
             ROW_NUMBER() OVER (
               PARTITION BY store_id
               ORDER BY version DESC
             ) AS rn
        FROM emails
    ) e ON e.store_id = s.id AND e.rn = 1

    -- The person to write to: the primary contact 4-08 ranked highest.
    LEFT JOIN (
      SELECT store_id, name, role, email, confidence,
             ROW_NUMBER() OVER (
               PARTITION BY store_id
               ORDER BY is_primary DESC, confidence DESC, id ASC
             ) AS rn
        FROM contacts
       WHERE is_generic = 0
    ) c ON c.store_id = s.id AND c.rn = 1

    -- LinkedIn lives on its own row as often as not: on keyshorts.com the
    -- founder came from JSON-LD and the company page from the footer.
    LEFT JOIN (
      SELECT store_id, linkedin_url,
             ROW_NUMBER() OVER (
               PARTITION BY store_id
               ORDER BY (linkedin_url LIKE '%/in/%') DESC, is_primary DESC, confidence DESC, id ASC
             ) AS rn
        FROM contacts
       WHERE linkedin_url IS NOT NULL
    ) li ON li.store_id = s.id AND li.rn = 1

    -- Shared inboxes, concatenated in insertion order — which is the ranked
    -- order, because saveContacts writes them ranked.
    LEFT JOIN (
      SELECT store_id,
             GROUP_CONCAT(email, ' ') AS generic_emails,
             COUNT(*) AS generic_count
        FROM contacts
       WHERE is_generic = 1 AND email IS NOT NULL
       GROUP BY store_id
    ) g ON g.store_id = s.id
  `;
}

function buildStoreFilters(filters: StoreFilters = {}) {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.domain) {
    conditions.push("LOWER(s.domain) LIKE LOWER(?)");
    params.push(`%${filters.domain}%`);
  }

  if (filters.rankMin !== undefined) {
    conditions.push("s.rank >= ?");
    params.push(filters.rankMin);
  }

  if (filters.rankMax !== undefined) {
    conditions.push("s.rank <= ?");
    params.push(filters.rankMax);
  }

  if (filters.scoreMin !== undefined) {
    conditions.push("COALESCE(a.lead_score, 0) >= ?");
    params.push(filters.scoreMin);
  }

  if (filters.scoreMax !== undefined) {
    conditions.push("COALESCE(a.lead_score, 0) <= ?");
    params.push(filters.scoreMax);
  }

  if (filters.revenueMin !== undefined) {
    conditions.push("s.revenue_estimate >= ?");
    params.push(filters.revenueMin * 100);
  }

  if (filters.revenueMax !== undefined) {
    conditions.push("s.revenue_estimate <= ?");
    params.push(filters.revenueMax * 100);
  }

  if (filters.issuesMin !== undefined) {
    conditions.push(`
      (
        COALESCE(i.critical_issues, 0) +
        COALESCE(i.major_issues, 0)
      ) >= ?
    `);
    params.push(filters.issuesMin);
  }

  if (filters.issuesMax !== undefined) {
    conditions.push(`
      (
        COALESCE(i.critical_issues, 0) +
        COALESCE(i.major_issues, 0)
      ) <= ?
    `);
    params.push(filters.issuesMax);
  }

  if (filters.status) {
    conditions.push("s.status = ?");
    params.push(filters.status);
  }

  if (filters.email) {
    conditions.push("e.status = ?");
    params.push(filters.email);
  }

  if (filters.category) {
    conditions.push("a.category = ?");
    params.push(filters.category);
  }

  // "Has at least one finding this bad", not "its worst is exactly this": a shop
  // with a critical issue is also a shop with major ones, and hiding it from the
  // MAJOR filter would make the two filters disagree about the same store.
  if (filters.severity === "CRITICAL") {
    conditions.push("COALESCE(i.critical_issues, 0) > 0");
  } else if (filters.severity === "MAJOR") {
    conditions.push("COALESCE(i.major_issues, 0) > 0");
  }

  return {
    where: conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "",
    params,
  };
}

function storeSelect(
  orderBy: string,
  filters: StoreFilters = {},
): {
  sql: string;
  params: SqlParam[];
} {
  const { where, params } = buildStoreFilters(filters);

  return {
    sql: `
      SELECT
        s.*,
        a.category,
        a.lead_score,
        COALESCE(i.critical_issues, 0) AS critical_issues,
        COALESCE(i.major_issues, 0) AS major_issues,
        e.status AS email_status,
        c.name AS contact_name,
        c.role AS contact_role,
        c.email AS contact_email,
        c.confidence AS contact_confidence,
        li.linkedin_url AS contact_linkedin,
        g.generic_emails,
        COALESCE(g.generic_count, 0) AS generic_count
      ${storeFrom()}
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `,
    params,
  };
}

export async function getDashboardData(query: DashboardQuery): Promise<DashboardData> {
  // node:sqlite is synchronous, so without this the query would run during
  // prerendering and bake a build-time snapshot into the page.
  await connection();

  const empty = paginate(0, 1, query.pageSize);
  if (!databaseReady()) {
    return {
      ready: false,
      runs: [],
      runsPage: empty,
      stores: [],
      storesPage: empty,
      runStatuses: new Set(),
      storeStatuses: new Set(),
      storeCategories: [],
      running: runningPipeline(),
      approved: 0,
    };
  }

  // Totals come first: the page number has to be clamped against them before
  // the OFFSET is computed, or a stale link would query past the end.
  const runsPage = paginate(count("SELECT COUNT(*) AS n FROM runs"), query.runsPage, query.pageSize);

  const storeFilter = buildStoreFilters(query.filters);

  const storesTotal =
    queryOne<{ n: number }>(
      `
      SELECT COUNT(*) AS n
      ${storeFrom()}
      ${storeFilter.where}
    `,
      storeFilter.params,
    )?.n ?? 0;

  const storesPage = paginate(
    storesTotal,
    query.storesPage,
    query.storesPageSize,
  );

  const runs = queryAll<RunRow>("SELECT * FROM runs ORDER BY id DESC LIMIT ? OFFSET ?", [
    runsPage.pageSize,
    runsPage.offset,
  ]);

  const storeQuery = storeSelect(
    buildOrderBy(query.sort, query.direction),
    query.filters,
  );

  const stores = queryAll<StoreListItem>(
    storeQuery.sql,
    [
      ...storeQuery.params,
      storesPage.pageSize,
      storesPage.offset,
    ],
  );

  return {
    ready: true,
    runs,
    runsPage,
    stores,
    storesPage,
    runStatuses: distinct("SELECT DISTINCT status AS value FROM runs"),
    storeStatuses: distinct("SELECT DISTINCT status AS value FROM stores"),
    // Only the categories that exist: offering a filter that can only ever
    // return nothing is worse than not offering it.
    storeCategories: queryAll<{ category: string }>(
      `SELECT DISTINCT category FROM ai_analyses
        WHERE agent = 'lead_classifier' AND category IS NOT NULL
        ORDER BY category`,
    ).map((row) => row.category),
    running: runningPipeline(),
    approved: count("SELECT COUNT(*) AS n FROM emails WHERE status = 'APPROVED'"),
  };
}

// ---------------------------------------------------------------- store detail

/** A contact as the card of 6-07 shows it. */
export interface StoreContactRow {
  id: number;
  name: string | null;
  role: string | null;
  email: string | null;
  linkedin_url: string | null;
  source: string;
  source_url: string | null;
  confidence: number;
  is_generic: number;
  is_primary: number;
}

/** One version of a letter, newest first, as the card of 6-08 shows it. */
export interface StoreEmailRow {
  id: number;
  version: number;
  status: string;
  subject: string;
  body: string;
  word_count: number | null;
  category: string | null;
  similarity: number | null;
  qc_passed: number | null;
  qc_json: string | null;
  created_at: string;
  contact_name: string | null;
}

/** One PageSpeed run, as the facts block of 6-04 shows it. */
export interface PagespeedRow {
  strategy: string;
  performance: number | null;
  accessibility: number | null;
  best_practices: number | null;
  seo: number | null;
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  ttfb_ms: number | null;
  fetched_at: string;
}

export interface ThemeRow {
  name: string | null;
  current_version: string | null;
  latest_version: string | null;
  version_gap: number | null;
  age_months: number | null;
  architecture: string | null;
  freshness: string | null;
}

export interface AppStackRow {
  total: number | null;
  size: string | null;
  groups_json: string | null;
}

/** One audit finding with its evidence, for the issues block of 6-05. */
export interface IssueRow {
  id: number;
  page: string;
  category: string;
  severity: string;
  title: string;
  detail: string | null;
  evidence_json: string | null;
  source: string;
}

export interface ScreenshotRow {
  id: number;
  page: string;
  viewport: string;
  width: number | null;
  height: number | null;
}

/** A step that failed for this store, so the page can say why data is missing. */
export interface StepFailure {
  step: string;
  error: string | null;
  finished_at: string | null;
}

export interface StoreDetail {
  store: StoreRow;
  /** The run the store was last seen in — what Regenerate attributes work to. */
  runId: number | null;
  category: string | null;
  leadScore: number | null;
  priority: string | null;
  reason: string | null;
  contacts: StoreContactRow[];
  emails: StoreEmailRow[];
  pagespeed: PagespeedRow[];
  theme: ThemeRow | null;
  apps: AppStackRow | null;
  appNames: string[];
  issues: IssueRow[];
  screenshots: ScreenshotRow[];
  failures: StepFailure[];
  running: LockInfo | null;
}

/**
 * Everything one store's page needs, in one place (tasks 6-07, 6-08).
 *
 * Every version of the letter is loaded, not just the newest. The rejected ones
 * are the point of keeping them: a reviewer comparing what QC refused against
 * what it passed is exactly the calibration pass of 5-09, and it cannot be done
 * from the latest row alone.
 */
export async function getStoreDetail(storeId: number): Promise<StoreDetail | null> {
  await connection();
  if (!databaseReady()) return null;

  const store = queryOne<StoreRow>("SELECT * FROM stores WHERE id = ?", [storeId]);
  if (!store) return null;

  const classification = queryOne<{
    category: string | null;
    lead_score: number | null;
    priority: string | null;
    reason: string | null;
  }>(
    `SELECT category, lead_score, priority, reason
       FROM ai_analyses
      WHERE store_id = ? AND agent = 'lead_classifier'
      ORDER BY id DESC LIMIT 1`,
    [storeId],
  );

  return {
    store,
    runId:
      queryOne<{ run_id: number }>(
        "SELECT run_id FROM run_stores WHERE store_id = ? ORDER BY run_id DESC LIMIT 1",
        [storeId],
      )?.run_id ?? null,
    category: classification?.category ?? null,
    leadScore: classification?.lead_score ?? null,
    priority: classification?.priority ?? null,
    reason: classification?.reason ?? null,
    contacts: queryAll<StoreContactRow>(
      `SELECT id, name, role, email, linkedin_url, source, source_url,
              confidence, is_generic, is_primary
         FROM contacts WHERE store_id = ?
        ORDER BY is_primary DESC, is_generic ASC, confidence DESC, id ASC`,
      [storeId],
    ),
    emails: queryAll<StoreEmailRow>(
      `SELECT e.id, e.version, e.status, e.subject, e.body, e.word_count, e.category,
              e.similarity, e.qc_passed, e.qc_json, e.created_at,
              (SELECT c.name FROM contacts c WHERE c.id = e.contact_id) AS contact_name
         FROM emails e WHERE e.store_id = ?
        ORDER BY e.version DESC`,
      [storeId],
    ),
    pagespeed: queryAll<PagespeedRow>(
      `SELECT strategy, performance, accessibility, best_practices, seo,
              lcp_ms, cls, inp_ms, ttfb_ms, fetched_at
         FROM pagespeed_results WHERE store_id = ?
        ORDER BY strategy = 'mobile' DESC, id DESC`,
      [storeId],
    ),
    theme:
      queryOne<ThemeRow>(
        `SELECT name, current_version, latest_version, version_gap, age_months,
                architecture, freshness
           FROM theme_info WHERE store_id = ?`,
        [storeId],
      ) ?? null,
    apps:
      queryOne<AppStackRow>("SELECT total, size, groups_json FROM app_stack WHERE store_id = ?", [
        storeId,
      ]) ?? null,
    appNames: queryAll<{ name: string }>(
      "SELECT name FROM store_apps WHERE store_id = ? ORDER BY name",
      [storeId],
    ).map((row) => row.name),
    // Only the newest audit: an older run's findings may have been fixed since,
    // and showing both would make a fixed issue look like a current one.
    issues: queryAll<IssueRow>(
      `SELECT id, page, category, severity, title, detail, evidence_json, source
         FROM audit_issues
        WHERE store_id = ?
          AND audit_id = (SELECT MAX(audit_id) FROM audit_issues WHERE store_id = ?)
        ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'MAJOR' THEN 1 ELSE 2 END,
                 page, id`,
      [storeId, storeId],
    ),
    screenshots: queryAll<ScreenshotRow>(
      `SELECT id, page, viewport, width, height
         FROM screenshots
        WHERE store_id = ?
          AND audit_id = (SELECT MAX(audit_id) FROM screenshots WHERE store_id = ?)
        ORDER BY page, viewport DESC`,
      [storeId, storeId],
    ),
    // Why a block is empty is a question the page should answer. Only the last
    // attempt of each step counts: a step that failed and then succeeded on a
    // later run is not a current problem.
    failures: queryAll<StepFailure>(
      `SELECT step, error, finished_at FROM step_logs
        WHERE store_id = ?
          AND id IN (SELECT MAX(id) FROM step_logs WHERE store_id = ? GROUP BY step)
          AND status = 'FAILED'
        ORDER BY step`,
      [storeId, storeId],
    ),
    running: runningPipeline(),
  };
}

/** Absolute path of one screenshot, read from the database rather than a URL. */
export function screenshotPath(id: number): string | null {
  if (!databaseReady()) return null;
  return (
    queryOne<{ path: string }>("SELECT path FROM screenshots WHERE id = ?", [id])?.path ?? null
  );
}

/**
 * Every approved letter, oldest first (task 6-09).
 *
 * Only `APPROVED`: the export is the hand-off to whoever sends these by hand, so
 * a draft nobody has looked at must not be in the file. Oldest first because the
 * person working through it goes top to bottom.
 */
export async function getApprovedLetters(): Promise<ApprovedLetter[]> {
  await connection();
  if (!databaseReady()) return [];

  return queryAll<ApprovedLetter>(
    `SELECT s.domain,
            c.name  AS contact_name,
            c.role  AS contact_role,
            c.email AS contact_email,
            e.subject, e.body, e.category, e.word_count, e.version, e.created_at,
            (SELECT a.lead_score FROM ai_analyses a
              WHERE a.store_id = e.store_id AND a.agent = 'lead_classifier'
              ORDER BY a.id DESC LIMIT 1) AS lead_score
       FROM emails e
       JOIN stores s ON s.id = e.store_id
       LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.status = 'APPROVED'
      ORDER BY e.id ASC`,
  );
}
