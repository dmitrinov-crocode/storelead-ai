import { findTheme, latestOf, loadThemeCatalog } from './themeCatalog.js';
import type { CatalogEntry, ThemeArchitecture, ThemeCatalog } from './themeCatalog.js';

/**
 * Theme freshness analysis (task 2-21).
 *
 * Everything here is derived from two facts StoreLeads gives us — the theme's
 * name and version — plus the reference in `themeCatalog.json`. Nothing is
 * guessed: a theme we cannot place produces nulls and says so in `reason`,
 * because "we do not know" and "it is fine" must not look the same downstream.
 *
 * Two independent signals decide the bucket, and the worse one wins:
 *
 *   - **how many releases behind** the store is, and
 *   - **how old the version they run** actually is.
 *
 * They disagree often and both matter. A theme that shipped twelve releases in a
 * busy year is less alarming than one three releases behind over four years, and
 * a store on the newest version of a theme abandoned in 2021 is not "fresh" at
 * all — which is why architecture sets a floor.
 */

export type ThemeFreshness =
  'fresh' | 'slightly_outdated' | 'outdated' | 'very_outdated' | 'severely_outdated';

/** Ordered worst-last, so a bucket can be compared by index. */
const FRESHNESS_ORDER: readonly ThemeFreshness[] = [
  'fresh',
  'slightly_outdated',
  'outdated',
  'very_outdated',
  'severely_outdated',
];

/**
 * Upper bound of each bucket: at most N releases behind.
 *
 * Calibrated against a real cadence rather than picked round: Dawn published 34
 * releases between June 2021 and August 2026, about seven a year. So eight
 * releases behind is roughly a year, sixteen roughly two. A theme that ships
 * rarely will look better on this scale than it deserves — which is why age is
 * measured separately and the worse of the two wins.
 */
const GAP_BUCKETS: readonly (readonly [number, ThemeFreshness])[] = [
  [0, 'fresh'],
  [3, 'slightly_outdated'],
  [8, 'outdated'],
  [16, 'very_outdated'],
  [Number.POSITIVE_INFINITY, 'severely_outdated'],
];

/** Upper bound of each bucket: version at most N months old. */
const AGE_BUCKETS: readonly (readonly [number, ThemeFreshness])[] = [
  [6, 'fresh'],
  [12, 'slightly_outdated'],
  [24, 'outdated'],
  [48, 'very_outdated'],
  [Number.POSITIVE_INFINITY, 'severely_outdated'],
];

/**
 * A theme from the pre-Online-Store-2.0 lineup stopped receiving updates in 2021.
 * Being on its final version does not make it current, so vintage can never score
 * better than this.
 */
const VINTAGE_FLOOR: ThemeFreshness = 'very_outdated';

/**
 * Applied when we know the newest version but not the releases in between: a
 * store that is not on the latest version is not fresh, and without dates that
 * is the strongest claim the data supports.
 */
const BEHIND_LATEST_FLOOR: ThemeFreshness = 'slightly_outdated';

export interface ThemeAnalysis {
  /** Catalogue display name when known, otherwise the raw name as reported. */
  name: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  /** Releases published after the one the store runs. */
  versionGap: number | null;
  /** Release date of the version the store runs — not of the latest one. */
  releasedAt: string | null;
  ageMonths: number | null;
  architecture: ThemeArchitecture | null;
  freshness: ThemeFreshness | null;
  /** False when the theme name is not in the reference at all. */
  catalogued: boolean;
  /** Which signals fired, in plain words — for logs and for grounding an AI claim. */
  reason: string;
}

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Accepts '2.1.0', 'v2.1', '17.9.0-beta'; anything else is not a version. */
export function parseVersion(input: string | null | undefined): SemanticVersion | null {
  if (typeof input !== 'string') return null;
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

export function compareVersions(a: SemanticVersion, b: SemanticVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Whole calendar months between two dates, so "released on the 30th" does not
 * become a month older the next morning.
 */
export function monthsBetween(from: Date, to: Date): number {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12;
  months += to.getUTCMonth() - from.getUTCMonth();
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

function bucketFor(
  value: number,
  buckets: readonly (readonly [number, ThemeFreshness])[],
): ThemeFreshness {
  for (const [limit, freshness] of buckets) {
    if (value <= limit) return freshness;
  }
  // Unreachable: the last bucket has no upper bound.
  return 'severely_outdated';
}

function worst(a: ThemeFreshness, b: ThemeFreshness): ThemeFreshness {
  return FRESHNESS_ORDER.indexOf(a) >= FRESHNESS_ORDER.indexOf(b) ? a : b;
}

export interface ThemeFacts {
  name?: string | null;
  version?: string | null;
}

export interface AnalyzeThemeOptions {
  catalog?: ThemeCatalog;
  now?: Date;
}

export function analyzeTheme(facts: ThemeFacts, options: AnalyzeThemeOptions = {}): ThemeAnalysis {
  const now = options.now ?? new Date();
  const catalog = options.catalog ?? loadThemeCatalog();
  const rawName =
    typeof facts.name === 'string' && facts.name.trim() !== '' ? facts.name.trim() : null;
  const currentVersion =
    typeof facts.version === 'string' && facts.version.trim() !== '' ? facts.version.trim() : null;

  const entry = findTheme(rawName, catalog);

  const analysis: ThemeAnalysis = {
    name: entry?.displayName ?? rawName,
    currentVersion,
    latestVersion: null,
    versionGap: null,
    releasedAt: null,
    ageMonths: null,
    architecture: entry?.architecture ?? null,
    freshness: null,
    catalogued: entry !== null,
    reason: '',
  };

  if (!entry) {
    analysis.reason = rawName
      ? `theme '${rawName}' is not in the reference — no architecture or version signal`
      : 'no theme reported by StoreLeads';
    return analysis;
  }

  const reasons: string[] = [];
  let freshness: ThemeFreshness | null = null;

  const current = parseVersion(currentVersion);
  const history = entry.releases;
  const latest = latestOf(entry);
  analysis.latestVersion = latest?.version ?? null;

  if (history.length > 0) {
    if (current) {
      const newer = history.filter((release) => {
        const parsed = parseVersion(release.version);
        return parsed !== null && compareVersions(parsed, current) > 0;
      });
      analysis.versionGap = newer.length;

      const bucket = bucketFor(newer.length, GAP_BUCKETS);
      freshness = bucket;
      reasons.push(`${newer.length} release(s) behind ${analysis.latestVersion}`);

      // The date is only claimed for an exact match; a version we do not have on
      // record gets no release date rather than a neighbour's.
      const exact = history.find((release) => release.version === currentVersion);
      if (exact) {
        analysis.releasedAt = exact.releasedAt;
        const released = new Date(`${exact.releasedAt}T00:00:00.000Z`);
        const months = Math.max(0, monthsBetween(released, now));
        analysis.ageMonths = months;
        const ageBucket = bucketFor(months, AGE_BUCKETS);
        freshness = worst(freshness, ageBucket);
        reasons.push(`running a version released ${months} month(s) ago`);
      }
    } else {
      reasons.push('no version reported, so the gap is unknown');
    }
  } else if (current && latest) {
    // We know the newest version but not what came between. That is enough to
    // say the store is behind — never enough to say by how much, or for how long.
    const newest = parseVersion(latest.version);
    if (newest && compareVersions(newest, current) > 0) {
      freshness = BEHIND_LATEST_FLOOR;
      reasons.push(
        `behind the newest known version ${latest.version}; ` +
          'the theme publishes no release history, so the distance is unknown',
      );
    } else {
      reasons.push(`on the newest known version ${latest.version}`);
    }
  } else if (current) {
    reasons.push('no public release history for this theme, so the gap is unknown');
  } else {
    reasons.push('no version reported, so the gap is unknown');
  }

  if (entry.architecture === 'vintage') {
    freshness = freshness ? worst(freshness, VINTAGE_FLOOR) : VINTAGE_FLOOR;
    reasons.push('pre-Online-Store-2.0 theme, unsupported since 2021');
  } else if (entry.architecture === 'theme_blocks' && freshness === null) {
    // The architecture itself did not exist before 2025, so the theme is new
    // even when we cannot see its version history.
    freshness = 'fresh';
    reasons.push('theme-blocks architecture, which only exists in recent themes');
  }

  analysis.freshness = freshness;
  analysis.reason = reasons.join('; ') || 'catalogued theme with no version signal';
  return analysis;
}

/** Re-exported so callers do not need the catalogue module for a type. */
export type { CatalogEntry, ThemeArchitecture };
