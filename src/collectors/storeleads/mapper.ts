import { normalizeDomain } from '../../lib/domain.js';
import type { StoreInput } from '../../db/repositories/stores.js';
import type { StoreLeadsApp, StoreLeadsDomain, StoreLeadsTheme } from './types.js';

/**
 * StoreLeads domain -> our Store model (task 1-07).
 *
 * Notable conversions:
 *   * `name` is the DNS domain, `merchant_name` is the shop's name — not interchangeable.
 *   * `estimated_sales` is monthly sales in USD *cents*; stored as-is in
 *     `stores.revenue_estimate` so no precision is lost.
 *   * StoreLeads exposes no growth attribute, so `growth_rate` is left null here and
 *     must be derived later by comparing `store_snapshots` across runs.
 */

export interface MappedStore {
  store: StoreInput;
  apps: { name: string; category: string | null }[];
  theme: {
    name: string | null;
    version: string | null;
    style: string | null;
    vendor: string | null;
  };
  technologies: string[];
  categories: string[];
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toInteger(value: unknown): number | null {
  const num = toFiniteNumber(value);
  return num === null ? null : Math.round(num);
}

/**
 * StoreLeads writes the literal string 'Unknown' where it has no value — most
 * often in `theme.version`, which was 'Unknown' for 28 of 60 sampled PL stores.
 * Storing it verbatim would make theme-age analysis (task 2-21) read a missing
 * version as a real one.
 */
const UNKNOWN_SENTINELS = new Set(['unknown', 'n/a', 'none']);

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return UNKNOWN_SENTINELS.has(trimmed.toLowerCase()) ? null : trimmed;
}

/** `theme` is documented as an object but has been seen as a bare string. */
function readTheme(theme: StoreLeadsDomain['theme']): StoreLeadsTheme {
  if (typeof theme === 'string') return { name: theme };
  return theme ?? {};
}

/**
 * Apps the store currently runs. The payload also carries apps it has removed,
 * marked `state: 'Inactive'` (40 of 681 apps in a 60-store sample) — counting
 * those would overstate the app stack complexity scored in task 2-23.
 */
function readApps(
  apps: StoreLeadsApp[] | null | undefined,
): { name: string; category: string | null }[] {
  if (!Array.isArray(apps)) return [];
  const seen = new Set<string>();
  const result: { name: string; category: string | null }[] = [];
  for (const app of apps) {
    const name = toNonEmptyString(app?.name);
    if (!name) continue;
    // Anything not explicitly Active is treated as removed.
    const state = toNonEmptyString(app?.state)?.toLowerCase();
    if (state !== null && state !== undefined && state !== 'active') continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // StoreLeads already classifies apps, so task 2-23 does not need its own map.
    result.push({ name, category: readStrings(app?.categories)[0] ?? null });
  }
  return result;
}

function readStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) =>
      typeof v === 'string'
        ? toNonEmptyString(v)
        : toNonEmptyString((v as { name?: unknown })?.name),
    )
    .filter((v): v is string => v !== null);
}

/**
 * Returns null when the payload has no usable domain — the caller skips the row
 * rather than inserting a store that can never be audited.
 */
export function mapDomain(
  raw: StoreLeadsDomain,
  options: { runId?: number | null } = {},
): MappedStore | null {
  const normalized = normalizeDomain(raw.name) ?? normalizeDomain(raw.platform_domain);
  if (!normalized) return null;

  const theme = readTheme(raw.theme);
  const apps = readApps(raw.apps);
  const appsCount = apps.length;

  const store: StoreInput = {
    domain: normalized.domain,
    url: normalized.url,
    name: toNonEmptyString(raw.merchant_name) ?? toNonEmptyString(raw.title),
    country: toNonEmptyString(raw.country_code)?.toUpperCase() ?? null,
    platform: toNonEmptyString(raw.platform)?.toLowerCase() ?? null,
    rank: toInteger(raw.rank),
    revenue_estimate: toInteger(raw.estimated_sales),
    traffic_estimate: toInteger(raw.estimated_visits),
    // StoreLeads has no growth attribute — see the module comment.
    growth_rate: null,
    products_count: toInteger(raw.product_count),
    // Prefer the counted apps over a payload count so the number matches store_apps.
    apps_count: appsCount > 0 ? appsCount : null,
    theme_name: toNonEmptyString(theme.name),
    theme_version: toNonEmptyString(theme.version),
    first_seen_run_id: options.runId ?? null,
  };

  return {
    store,
    apps,
    theme: {
      name: toNonEmptyString(theme.name),
      version: toNonEmptyString(theme.version),
      style: toNonEmptyString(theme.style),
      vendor: toNonEmptyString(theme.vendor),
    },
    technologies: readStrings(raw.technologies),
    categories: readStrings(raw.categories),
  };
}

/** Maps a page of domains, dropping rows without a usable domain. */
export function mapDomains(
  domains: readonly StoreLeadsDomain[],
  options: { runId?: number | null } = {},
): { mapped: MappedStore[]; skipped: number } {
  const mapped: MappedStore[] = [];
  let skipped = 0;
  for (const raw of domains) {
    const result = mapDomain(raw, options);
    if (result) mapped.push(result);
    else skipped += 1;
  }
  return { mapped, skipped };
}
