/**
 * App-stack analysis (task 2-23).
 *
 * Two questions about a store's apps: how many, and what kind. Both are answered
 * from `store_apps`, which `fetch_stores` fills from StoreLeads — including the
 * categories StoreLeads assigns, so no classifier of our own is needed.
 *
 * The plan named nine groups. StoreLeads slices its catalogue far finer — 61
 * distinct category strings across 358 apps in the first sample — so the mapping
 * below is deliberately partial: a category is grouped only where it genuinely
 * belongs, and everything else lands in `other` rather than being forced into a
 * bucket to make the numbers look tidy.
 */

export type AppGroup =
  | 'marketing'
  | 'reviews'
  | 'analytics'
  | 'upsell'
  | 'loyalty'
  | 'subscription'
  | 'search'
  | 'personalization'
  | 'tracking'
  | 'other';

export const APP_GROUPS: readonly AppGroup[] = [
  'marketing',
  'reviews',
  'analytics',
  'upsell',
  'loyalty',
  'subscription',
  'search',
  'personalization',
  'tracking',
  'other',
];

export type AppStackSize = 'low' | 'medium' | 'high' | 'very_high';

/**
 * Calibrated on the first 37 Polish Shopify stores: median 9 apps, quartiles at
 * 6 and 14, largest stack 26. The boundaries follow those quartiles rather than
 * round numbers, so "high" means high *for this segment*.
 */
const SIZE_BUCKETS: readonly (readonly [number, AppStackSize])[] = [
  [5, 'low'],
  [12, 'medium'],
  [20, 'high'],
  [Number.POSITIVE_INFINITY, 'very_high'],
];

/**
 * StoreLeads category → our group. Keys are StoreLeads' own strings, lowercased.
 *
 * `tracking` is worth a note: StoreLeads has no pixel or conversion-tracking
 * category at all, so the group counts order-tracking apps — the only "tracking"
 * the source actually reports. Measurement apps live under `analytics`.
 */
const CATEGORY_GROUPS: Record<string, AppGroup> = {
  // marketing
  'email marketing': 'marketing',
  ads: 'marketing',
  'pop-ups': 'marketing',
  banners: 'marketing',
  'countdown timer': 'marketing',
  'affiliate programs': 'marketing',
  discounts: 'marketing',
  'social proof': 'marketing',
  'marketing - other': 'marketing',
  forms: 'marketing',
  // Back-in-stock notifications are lifecycle email, not inventory management.
  'stock alerts': 'marketing',

  // reviews
  'product reviews': 'reviews',
  'social trust - other': 'reviews',

  // analytics
  analytics: 'analytics',

  // upsell
  'upsell and cross-sell': 'upsell',
  'product bundles': 'upsell',

  // loyalty
  'loyalty and rewards': 'loyalty',
  wishlists: 'loyalty',

  // subscription
  subscriptions: 'subscription',

  // search
  'search and filters': 'search',
  'navigation and menus': 'search',

  // personalization
  geolocation: 'personalization',
  'currency and translation': 'personalization',
  'language and translation': 'personalization',

  // tracking
  'order tracking': 'tracking',
};

export function groupForCategory(category: string | null | undefined): AppGroup {
  if (typeof category !== 'string') return 'other';
  return CATEGORY_GROUPS[category.trim().toLowerCase()] ?? 'other';
}

export function sizeBucket(count: number): AppStackSize | null {
  if (!Number.isFinite(count) || count < 0) return null;
  for (const [limit, bucket] of SIZE_BUCKETS) {
    if (count <= limit) return bucket;
  }
  return 'very_high';
}

export interface AppRecord {
  name: string;
  category: string | null;
}

export interface AppStackAnalysis {
  /** Apps we hold names for. */
  total: number;
  /** What StoreLeads counted, which can exceed `total`. */
  reportedCount: number | null;
  size: AppStackSize | null;
  /** Every group, including the zeros — a missing reviews app is itself a signal. */
  byGroup: Record<AppGroup, number>;
  /** Groups with at least one app, in the canonical order. */
  groupsPresent: AppGroup[];
  /** Apps StoreLeads left without a category. */
  uncategorised: number;
  /**
   * What went into `other`, largest first. Roughly a third of installed apps land
   * there — compliance, support, SEO and checkout tools that the nine groups were
   * never meant to cover — and dropping their names would hide real facts about
   * the store.
   */
  otherCategories: { category: string; count: number }[];
  reason: string;
}

export interface AnalyzeAppsOptions {
  /** `stores.apps_count`; used for the size bucket when it is larger than what we hold. */
  reportedCount?: number | null;
}

export function analyzeApps(
  apps: readonly AppRecord[],
  options: AnalyzeAppsOptions = {},
): AppStackAnalysis {
  const byGroup = Object.fromEntries(APP_GROUPS.map((g) => [g, 0])) as Record<AppGroup, number>;
  const otherCounts = new Map<string, number>();
  let uncategorised = 0;

  for (const app of apps) {
    const category = typeof app.category === 'string' ? app.category.trim() : '';
    if (category === '') uncategorised += 1;

    const group = groupForCategory(app.category);
    byGroup[group] += 1;
    if (group === 'other' && category !== '') {
      otherCounts.set(category, (otherCounts.get(category) ?? 0) + 1);
    }
  }

  const otherCategories = [...otherCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  const reportedCount = options.reportedCount ?? null;
  // StoreLeads' own count wins when it is higher: it sees apps we have no row for.
  const counted = Math.max(apps.length, reportedCount ?? 0);
  const size = counted > 0 ? sizeBucket(counted) : null;

  const groupsPresent = APP_GROUPS.filter((g) => byGroup[g] > 0);

  return {
    total: apps.length,
    reportedCount,
    size,
    byGroup,
    groupsPresent,
    uncategorised,
    otherCategories,
    reason:
      counted === 0
        ? 'no apps recorded for this store'
        : `${counted} app(s), ${groupsPresent.filter((g) => g !== 'other').length} of 9 groups covered`,
  };
}
