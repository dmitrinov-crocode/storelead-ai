import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The theme reference (tasks 2-21, 2-22).
 *
 * Two kinds of fact live here and they age very differently:
 *
 *   - **Architecture** is stable. Debut was a pre-Online-Store-2.0 theme when it
 *     shipped and will never become anything else, so classifying it by name is
 *     safe indefinitely.
 *   - **Release history** goes out of date the moment a theme ships a version.
 *     Only themes with a public, checkable source carry it — today that is Dawn,
 *     from its GitHub releases. Paid themes publish nothing machine-readable, so
 *     they get an architecture and nothing else, and the analyser reports "no
 *     version signal" rather than inventing one.
 *
 * A theme missing from the file is not an error: it means we cannot say anything
 * about it, which is different from saying it is fine.
 */

export type ThemeArchitecture = 'vintage' | 'os2' | 'theme_blocks' | 'custom';

export interface ThemeRelease {
  version: string;
  /** ISO date, YYYY-MM-DD. */
  releasedAt: string;
}

export interface CatalogEntry {
  displayName: string;
  /**
   * Omitted when we cannot verify it. A paid theme's architecture depends on the
   * version the store runs, not on its name, so guessing from the name would put
   * an unchecked claim in front of a customer.
   */
  architecture?: ThemeArchitecture;
  /** Where the classification came from — kept so 2-22 can re-check it. */
  source: string;
  /**
   * `owner/repo` when the theme is published on GitHub. Only these entries can be
   * refreshed automatically; everything else is maintained by hand — see
   * `docs/THEMES.md`.
   */
  github?: string;
  /**
   * The newest version we know of. Filled even for themes with no release
   * history: Horizon's repository carries its version in
   * `config/settings_schema.json` but publishes neither releases nor tags.
   * `releasedAt` is null when the source gives a version without a date.
   */
  latest?: { version: string; releasedAt: string | null };
  /** Newest first. Empty when no public history exists. */
  releases: ThemeRelease[];
}

export interface ThemeCatalog {
  updatedAt: string;
  note?: string;
  themes: Record<string, CatalogEntry | undefined>;
}

/** The newest version on record, from the history when there is one. */
export function latestOf(
  entry: CatalogEntry,
): { version: string; releasedAt: string | null } | null {
  const newest = entry.releases[0];
  if (newest) return { version: newest.version, releasedAt: newest.releasedAt };
  return entry.latest ?? null;
}

const CATALOG_PATH = path.join(import.meta.dirname, 'themeCatalog.json');

let cached: ThemeCatalog | undefined;

export function loadThemeCatalog(): ThemeCatalog {
  cached ??= JSON.parse(readFileSync(CATALOG_PATH, 'utf-8')) as ThemeCatalog;
  return cached;
}

/**
 * Lookup key for a theme name. StoreLeads reports the merchant's own copy of the
 * theme, so the same theme arrives as 'Dawn', 'dawn' and 'Dawn 2.0' — and often
 * as something the merchant renamed entirely ('keyshortscom/main'), which simply
 * will not be found.
 */
/** Writes the reference back and drops the memo, so a refresh takes effect at once. */
export function saveThemeCatalog(catalog: ThemeCatalog): void {
  writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');
  cached = catalog;
}

export function catalogPath(): string {
  return CATALOG_PATH;
}

export function catalogKey(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

export function findTheme(
  name: string | null | undefined,
  catalog: ThemeCatalog = loadThemeCatalog(),
): CatalogEntry | null {
  const key = catalogKey(name);
  if (!key) return null;
  return catalog.themes[key] ?? null;
}
