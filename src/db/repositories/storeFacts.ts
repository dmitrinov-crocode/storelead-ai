import { execute, queryAll, type Database } from '../client.js';
import type { AppStackRow, PagespeedRow, StoreAppRow, ThemeInfoRow } from '../types.js';
import { nowIso } from '../../lib/time.js';

/** Per-store facts that are not audit findings: theme, apps, PageSpeed (tasks 1-07, 2-19, 2-21, 2-23). */

export function saveStoreApps(
  storeId: number,
  apps: readonly { name: string; category?: string | null }[],
  db?: Database,
): void {
  for (const app of apps) {
    execute(
      `INSERT INTO store_apps (store_id, name, category) VALUES (?, ?, ?)
       ON CONFLICT (store_id, name) DO UPDATE
          SET category = COALESCE(excluded.category, store_apps.category)`,
      [storeId, app.name, app.category ?? null],
      db,
    );
  }
}

export function listStoreApps(storeId: number, db?: Database): StoreAppRow[] {
  return queryAll<StoreAppRow>(
    'SELECT * FROM store_apps WHERE store_id = ? ORDER BY name',
    [storeId],
    db,
  );
}

export interface ThemeFacts {
  name?: string | null;
  currentVersion?: string | null;
  architecture?: string | null;
}

/**
 * Upserts what we know about the theme now. Epic 2 fills in latest_version,
 * version_gap, age and freshness, so those columns are never cleared here.
 */
export function saveThemeInfo(storeId: number, theme: ThemeFacts, db?: Database): void {
  execute(
    `INSERT INTO theme_info (store_id, name, current_version, architecture, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (store_id) DO UPDATE
        SET name            = COALESCE(excluded.name, theme_info.name),
            current_version = COALESCE(excluded.current_version, theme_info.current_version),
            architecture    = COALESCE(excluded.architecture, theme_info.architecture),
            updated_at      = excluded.updated_at`,
    [
      storeId,
      theme.name ?? null,
      theme.currentVersion ?? null,
      theme.architecture ?? null,
      nowIso(),
    ],
    db,
  );
}

export interface AppStackFacts {
  total: number;
  reportedCount?: number | null;
  size?: string | null;
  byGroup: Record<string, number>;
  otherCategories?: { category: string; count: number }[];
  uncategorised?: number;
}

/**
 * Stores the app-stack verdict (task 2-23). Overwritten wholesale: the grouping
 * is a pure function of `store_apps` plus the mapping table, so a re-run after
 * the mapping changes must replace the old answer rather than merge with it.
 */
export function saveAppStack(storeId: number, facts: AppStackFacts, db?: Database): void {
  execute(
    `INSERT INTO app_stack (
       store_id, total, reported_count, size, groups_json, other_json, uncategorised, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (store_id) DO UPDATE
        SET total          = excluded.total,
            reported_count = excluded.reported_count,
            size           = excluded.size,
            groups_json    = excluded.groups_json,
            other_json     = excluded.other_json,
            uncategorised  = excluded.uncategorised,
            updated_at     = excluded.updated_at`,
    [
      storeId,
      facts.total,
      facts.reportedCount ?? null,
      facts.size ?? null,
      JSON.stringify(facts.byGroup),
      facts.otherCategories && facts.otherCategories.length > 0
        ? JSON.stringify(facts.otherCategories)
        : null,
      facts.uncategorised ?? 0,
      nowIso(),
    ],
    db,
  );
}

export function getAppStack(storeId: number, db?: Database): AppStackRow | undefined {
  return queryAll<AppStackRow>('SELECT * FROM app_stack WHERE store_id = ?', [storeId], db)[0];
}

export interface ThemeAnalysisFacts {
  name?: string | null;
  currentVersion?: string | null;
  latestVersion?: string | null;
  versionGap?: number | null;
  releasedAt?: string | null;
  ageMonths?: number | null;
  architecture?: string | null;
  freshness?: string | null;
}

/**
 * Writes the derived theme verdict (task 2-21).
 *
 * Unlike `saveThemeInfo`, which merges the raw facts StoreLeads reported, every
 * derived column is overwritten — nulls included. The analysis is a pure function
 * of (name, version, reference), so a re-run after the reference is refreshed
 * must be able to *withdraw* a verdict, not only to raise one.
 */
export function saveThemeAnalysis(
  storeId: number,
  analysis: ThemeAnalysisFacts,
  db?: Database,
): void {
  execute(
    `INSERT INTO theme_info (
       store_id, name, current_version, latest_version, version_gap,
       released_at, age_months, architecture, freshness, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (store_id) DO UPDATE
        SET name            = COALESCE(excluded.name, theme_info.name),
            current_version = COALESCE(excluded.current_version, theme_info.current_version),
            latest_version  = excluded.latest_version,
            version_gap     = excluded.version_gap,
            released_at     = excluded.released_at,
            age_months      = excluded.age_months,
            architecture    = excluded.architecture,
            freshness       = excluded.freshness,
            updated_at      = excluded.updated_at`,
    [
      storeId,
      analysis.name ?? null,
      analysis.currentVersion ?? null,
      analysis.latestVersion ?? null,
      analysis.versionGap ?? null,
      analysis.releasedAt ?? null,
      analysis.ageMonths ?? null,
      analysis.architecture ?? null,
      analysis.freshness ?? null,
      nowIso(),
    ],
    db,
  );
}

export function getThemeInfo(storeId: number, db?: Database): ThemeInfoRow | undefined {
  return queryAll<ThemeInfoRow>('SELECT * FROM theme_info WHERE store_id = ?', [storeId], db)[0];
}

/**
 * PageSpeed scores for the AI context (task 3-01). `raw_json` comes along in the
 * row but no caller puts it in a prompt — every metric worth reading is a column.
 */
export function listPagespeedResults(storeId: number, db?: Database): PagespeedRow[] {
  return queryAll<PagespeedRow>(
    'SELECT * FROM pagespeed_results WHERE store_id = ? ORDER BY strategy',
    [storeId],
    db,
  );
}

export function getPagespeedResult(
  storeId: number,
  strategy: PagespeedStrategyName,
  db?: Database,
): PagespeedRow | undefined {
  return queryAll<PagespeedRow>(
    'SELECT * FROM pagespeed_results WHERE store_id = ? AND strategy = ?',
    [storeId, strategy],
    db,
  )[0];
}

export type PagespeedStrategyName = 'mobile' | 'desktop';

export interface PagespeedFacts {
  strategy: PagespeedStrategyName;
  performance?: number | null;
  accessibility?: number | null;
  bestPractices?: number | null;
  seo?: number | null;
  fcpMs?: number | null;
  lcpMs?: number | null;
  cls?: number | null;
  inpMs?: number | null;
  ttfbMs?: number | null;
  speedIndexMs?: number | null;
  /** The API response, or a record of why there is none. */
  raw?: unknown;
  /** Overridable so tests and backfills can write a deliberate timestamp. */
  fetchedAt?: string;
}

/**
 * Upserts one (store, strategy) result (task 2-20).
 *
 * Every column is overwritten, nulls included: a fresh analysis that failed must
 * replace yesterday's scores rather than leave them standing next to a new
 * `fetched_at`. `fetched_at` is the cache key — see `collectors/pagespeed/cache.ts`.
 */
export function savePagespeedResult(storeId: number, facts: PagespeedFacts, db?: Database): void {
  execute(
    `INSERT INTO pagespeed_results (
       store_id, strategy, performance, accessibility, best_practices, seo,
       fcp_ms, lcp_ms, cls, inp_ms, ttfb_ms, speed_index_ms, raw_json, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (store_id, strategy) DO UPDATE
        SET performance    = excluded.performance,
            accessibility  = excluded.accessibility,
            best_practices = excluded.best_practices,
            seo            = excluded.seo,
            fcp_ms         = excluded.fcp_ms,
            lcp_ms         = excluded.lcp_ms,
            cls            = excluded.cls,
            inp_ms         = excluded.inp_ms,
            ttfb_ms        = excluded.ttfb_ms,
            speed_index_ms = excluded.speed_index_ms,
            raw_json       = excluded.raw_json,
            fetched_at     = excluded.fetched_at`,
    [
      storeId,
      facts.strategy,
      facts.performance ?? null,
      facts.accessibility ?? null,
      facts.bestPractices ?? null,
      facts.seo ?? null,
      facts.fcpMs ?? null,
      facts.lcpMs ?? null,
      facts.cls ?? null,
      facts.inpMs ?? null,
      facts.ttfbMs ?? null,
      facts.speedIndexMs ?? null,
      facts.raw === undefined ? null : JSON.stringify(facts.raw),
      facts.fetchedAt ?? nowIso(),
    ],
    db,
  );
}
