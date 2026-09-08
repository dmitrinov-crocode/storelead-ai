import type { CatalogEntry, ThemeCatalog, ThemeRelease } from './themeCatalog.js';
import { latestOf } from './themeCatalog.js';

/**
 * Refreshing the theme reference (task 2-22).
 *
 * Only two theme repositories are public — `Shopify/dawn` and `Shopify/horizon`
 * (checked against the GitHub API on 2026-09-01; every other free-theme name
 * returns 404). They need different treatment, which is the whole reason this
 * module exists:
 *
 *   - **Dawn** publishes GitHub releases, so we get a full history with dates —
 *     enough to count how many releases a store is behind and how old its
 *     version is.
 *   - **Horizon** publishes neither releases nor tags. Its version lives in
 *     `config/settings_schema.json` on the default branch, which gives the newest
 *     version and nothing else.
 *
 * Paid themes publish nothing machine-readable at all; they are maintained by
 * hand, with a cited source. See `docs/THEMES.md`.
 *
 * One rule shapes the error handling: **a failed fetch never edits an entry.**
 * GitHub being down must not silently empty the reference and turn every store's
 * verdict into "unknown".
 */

const GITHUB_API = 'https://api.github.com';
const RAW_CONTENT = 'https://raw.githubusercontent.com';
const MAX_PAGES = 5;

interface GithubRelease {
  tag_name?: string;
  published_at?: string | null;
  prerelease?: boolean;
  draft?: boolean;
}

interface SettingsSchemaBlock {
  name?: string;
  theme_name?: string;
  theme_version?: string;
}

export interface ThemeUpdate {
  key: string;
  displayName: string;
  /** Newest version before the refresh. */
  from: string | null;
  /** Newest version after it. */
  to: string | null;
  releases: number;
  changed: boolean;
  /** Set when the entry could not be refreshed; its data is left untouched. */
  error?: string;
}

export interface UpdateCatalogOptions {
  fetchImpl?: typeof fetch;
  /** Personal access token; raises the GitHub rate limit from 60/h to 5000/h. */
  token?: string | undefined;
  /** Branch holding `config/settings_schema.json`. */
  branch?: string;
  now?: Date;
}

export interface UpdateCatalogResult {
  catalog: ThemeCatalog;
  updates: ThemeUpdate[];
  /** True when any entry's newest version or history changed. */
  changed: boolean;
}

function stripTagPrefix(tag: string): string {
  return tag.replace(/^v/i, '');
}

/** Releases as the analyser wants them: newest first, prereleases and drafts dropped. */
export function toReleases(raw: readonly GithubRelease[]): ThemeRelease[] {
  const releases: ThemeRelease[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (item.prerelease || item.draft) continue;
    if (!item.tag_name || !item.published_at) continue;
    const version = stripTagPrefix(item.tag_name);
    if (seen.has(version)) continue;
    seen.add(version);
    releases.push({ version, releasedAt: item.published_at.slice(0, 10) });
  }

  return releases.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
}

/** Pulls `theme_version` out of a theme's `config/settings_schema.json`. */
export function readSettingsVersion(schema: unknown): string | null {
  if (!Array.isArray(schema)) return null;
  for (const block of schema as SettingsSchemaBlock[]) {
    if (block?.name === 'theme_info' && typeof block.theme_version === 'string') {
      const version = block.theme_version.trim();
      if (version !== '') return version;
    }
  }
  return null;
}

async function fetchOne(
  url: string,
  options: { fetchImpl: typeof fetch; token: string | undefined },
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await options.fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function refreshEntry(
  entry: CatalogEntry,
  options: { fetchImpl: typeof fetch; token: string | undefined; branch: string },
): Promise<CatalogEntry> {
  const repo = entry.github;
  if (!repo) return entry;

  const collected: GithubRelease[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = (await fetchOne(
      `${GITHUB_API}/repos/${repo}/releases?per_page=100&page=${page}`,
      options,
    )) as GithubRelease[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    collected.push(...batch);
    if (batch.length < 100) break;
  }

  const releases = toReleases(collected);
  if (releases.length > 0) {
    const newest = releases[0]!;
    return {
      ...entry,
      latest: { version: newest.version, releasedAt: newest.releasedAt },
      releases,
    };
  }

  // No releases: fall back to the version the theme declares in its settings.
  const schema = await fetchOne(
    `${RAW_CONTENT}/${repo}/${options.branch}/config/settings_schema.json`,
    options,
  );
  const version = readSettingsVersion(schema);
  if (!version) {
    throw new Error(`no releases and no theme_version in config/settings_schema.json for ${repo}`);
  }
  return { ...entry, latest: { version, releasedAt: null }, releases: [] };
}

export async function updateThemeCatalog(
  catalog: ThemeCatalog,
  options: UpdateCatalogOptions = {},
): Promise<UpdateCatalogResult> {
  const fetchOptions = {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    token: options.token,
    branch: options.branch ?? 'main',
  };
  const now = options.now ?? new Date();

  const themes: ThemeCatalog['themes'] = { ...catalog.themes };
  const updates: ThemeUpdate[] = [];
  let changed = false;

  for (const [key, entry] of Object.entries(catalog.themes)) {
    if (!entry?.github) continue;

    const before = latestOf(entry);
    try {
      const refreshed = await refreshEntry(entry, fetchOptions);
      const after = latestOf(refreshed);
      const entryChanged =
        before?.version !== after?.version || entry.releases.length !== refreshed.releases.length;

      themes[key] = refreshed;
      if (entryChanged) changed = true;
      updates.push({
        key,
        displayName: entry.displayName,
        from: before?.version ?? null,
        to: after?.version ?? null,
        releases: refreshed.releases.length,
        changed: entryChanged,
      });
    } catch (error) {
      // Keep whatever we already had: a stale version beats no version.
      updates.push({
        key,
        displayName: entry.displayName,
        from: before?.version ?? null,
        to: before?.version ?? null,
        releases: entry.releases.length,
        changed: false,
        error: (error as Error).message,
      });
    }
  }

  return {
    // `updatedAt` records when the reference was last *checked*, not last changed.
    catalog: { ...catalog, updatedAt: now.toISOString().slice(0, 10), themes },
    updates,
    changed,
  };
}
