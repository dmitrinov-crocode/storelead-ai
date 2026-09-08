import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeApps, APP_GROUPS, groupForCategory, sizeBucket } from './apps.js';

function apps(...pairs: [string, string | null][]) {
  return pairs.map(([name, category]) => ({ name, category }));
}

test('size buckets follow the quartiles of the real sample', () => {
  assert.equal(sizeBucket(1), 'low');
  assert.equal(sizeBucket(5), 'low');
  assert.equal(sizeBucket(6), 'medium');
  assert.equal(sizeBucket(12), 'medium');
  assert.equal(sizeBucket(13), 'high');
  assert.equal(sizeBucket(20), 'high');
  assert.equal(sizeBucket(21), 'very_high');
  assert.equal(sizeBucket(200), 'very_high');
});

test('a nonsensical count has no bucket', () => {
  assert.equal(sizeBucket(-1), null);
  assert.equal(sizeBucket(Number.NaN), null);
});

test('maps StoreLeads categories onto the nine groups', () => {
  assert.equal(groupForCategory('email marketing'), 'marketing');
  assert.equal(groupForCategory('product reviews'), 'reviews');
  assert.equal(groupForCategory('upsell and cross-sell'), 'upsell');
  assert.equal(groupForCategory('loyalty and rewards'), 'loyalty');
  assert.equal(groupForCategory('subscriptions'), 'subscription');
  assert.equal(groupForCategory('search and filters'), 'search');
  assert.equal(groupForCategory('currency and translation'), 'personalization');
  assert.equal(groupForCategory('order tracking'), 'tracking');
});

test('matches categories regardless of case and padding', () => {
  assert.equal(groupForCategory('  Email Marketing '), 'marketing');
});

test('a category outside the nine groups is not forced into one', () => {
  // Real StoreLeads categories from the first sample; none of them is one of the
  // nine, and pretending otherwise would put a wrong count in front of a customer.
  for (const category of ['seo', 'chat', 'legal', 'cookie consent', 'fraud', 'pre-orders']) {
    assert.equal(groupForCategory(category), 'other', category);
  }
  assert.equal(groupForCategory(null), 'other');
  assert.equal(groupForCategory(undefined), 'other');
});

test('counts every group, including the ones that are empty', () => {
  const result = analyzeApps(
    apps(
      ['Klaviyo', 'email marketing'],
      ['Judge.me', 'product reviews'],
      ['ReConvert', 'upsell and cross-sell'],
      ['Bundler', 'product bundles'],
    ),
  );

  assert.equal(result.byGroup.marketing, 1);
  assert.equal(result.byGroup.reviews, 1);
  assert.equal(result.byGroup.upsell, 2);
  // A missing group is a signal in itself, so every key is present with a zero.
  assert.deepEqual(Object.keys(result.byGroup).sort(), [...APP_GROUPS].sort());
  assert.equal(result.byGroup.loyalty, 0);
  assert.deepEqual(result.groupsPresent, ['marketing', 'reviews', 'upsell']);
});

test('keeps the names of the categories that fell outside the nine groups', () => {
  const result = analyzeApps(
    apps(
      ['Plug in SEO', 'seo'],
      ['SEO Manager', 'seo'],
      ['Tidio', 'chat'],
      ['Klaviyo', 'email marketing'],
    ),
  );

  assert.equal(result.byGroup.other, 3);
  assert.deepEqual(result.otherCategories, [
    { category: 'seo', count: 2 },
    { category: 'chat', count: 1 },
  ]);
});

test('counts apps StoreLeads left without a category', () => {
  const result = analyzeApps(
    apps(['Mystery App', null], ['Blank', '  '], ['Klaviyo', 'email marketing']),
  );

  assert.equal(result.uncategorised, 2);
  assert.equal(result.byGroup.other, 2);
  // An empty category contributes no name to the breakdown.
  assert.deepEqual(result.otherCategories, []);
});

test("uses StoreLeads' own count when it exceeds the apps we hold names for", () => {
  const result = analyzeApps(apps(['Klaviyo', 'email marketing']), { reportedCount: 22 });

  assert.equal(result.total, 1);
  assert.equal(result.reportedCount, 22);
  // The store runs 22 apps; we only have one name. The stack is still very large.
  assert.equal(result.size, 'very_high');
});

test('a smaller reported count does not shrink what we can see', () => {
  const result = analyzeApps(
    apps(['a', 'seo'], ['b', 'seo'], ['c', 'seo'], ['d', 'seo'], ['e', 'seo'], ['f', 'seo']),
    { reportedCount: 2 },
  );

  assert.equal(result.size, 'medium');
});

test('a store with no apps has no size at all', () => {
  const result = analyzeApps([], { reportedCount: null });

  assert.equal(result.total, 0);
  assert.equal(result.size, null);
  assert.match(result.reason, /no apps recorded/);
});

test('reports how much of the taxonomy a stack covers', () => {
  const result = analyzeApps(
    apps(['Klaviyo', 'email marketing'], ['Judge.me', 'product reviews'], ['Plug in SEO', 'seo']),
  );

  // 'other' is not one of the nine.
  assert.match(result.reason, /3 app\(s\), 2 of 9 groups covered/);
});
