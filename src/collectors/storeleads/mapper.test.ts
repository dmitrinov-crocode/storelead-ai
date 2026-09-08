import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mapDomain, mapDomains } from './mapper.js';
import type { StoreLeadsDomain, StoreLeadsListResponse } from './types.js';

/** A response recorded from the live API — see the fixture's own _comment. */
const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'list-response.json'), 'utf-8'),
) as StoreLeadsListResponse;

const domains = fixture.domains ?? [];
const [milla, canvas, keyshorts] = domains;

test('the recorded fixture has the envelope the live API returns', () => {
  assert.ok(Array.isArray(fixture.domains));
  assert.equal(typeof fixture.total, 'number');
  assert.equal(typeof fixture.has_next_page, 'boolean');
  assert.equal(typeof fixture.next_cursor, 'string');
  assert.ok(!('pagination' in fixture), 'there is no nested pagination object');
});

test('maps a real domain payload onto the store model', () => {
  const result = mapDomain(milla!, { runId: 7 });
  assert.ok(result);

  assert.deepEqual(result.store, {
    domain: 'itsmilla.com',
    url: 'https://itsmilla.com',
    name: 'Milla',
    country: 'PL',
    platform: 'shopify',
    rank: 3178,
    revenue_estimate: 160349984,
    traffic_estimate: 282283,
    growth_rate: null,
    products_count: 308,
    apps_count: 4,
    theme_name: 'streamline',
    theme_version: '3.2.1',
    first_seen_run_id: 7,
  });
});

test('uses the DNS name for identity and merchant_name for the label', () => {
  const result = mapDomain(milla!)!;
  assert.equal(result.store.domain, 'itsmilla.com');
  assert.equal(result.store.name, 'Milla', 'not the page title');
});

test("treats the API's 'Unknown' sentinel as a missing value", () => {
  // theme.version is literally "Unknown" for this store — 28 of 60 sampled stores
  // are like this, so storing the string would corrupt theme-age analysis.
  assert.equal((canvas!.theme as { version: string }).version, 'Unknown', 'fixture precondition');

  const result = mapDomain(canvas!)!;
  assert.equal(result.store.theme_version, null);
  assert.equal(result.theme.style, null, 'style is "Unknown" too');
  assert.equal(result.theme.vendor, null);
  assert.equal(result.store.theme_name, 'unsen', 'a real name survives');
});

test('keeps only apps the store currently runs', () => {
  const raw: StoreLeadsDomain = {
    name: 'shop.pl',
    apps: [
      { name: 'Klaviyo', state: 'Active', categories: ['email marketing'] },
      { name: 'Old Upsell', state: 'Inactive', categories: ['upsell'] },
      { name: 'Judge.me', state: 'Active', categories: ['product reviews'] },
    ],
  };
  const result = mapDomain(raw)!;

  assert.deepEqual(
    result.apps.map((a) => a.name),
    ['Klaviyo', 'Judge.me'],
    'Inactive apps are removed apps, not part of the stack',
  );
  assert.equal(result.store.apps_count, 2);
});

test('carries the app category StoreLeads already assigns', () => {
  const result = mapDomain(milla!)!;
  assert.deepEqual(result.apps.slice(0, 2), [
    { name: 'AfterShip Order Tracking', category: 'order tracking' },
    { name: 'Attentive: AI‑led Email &SMS', category: 'email marketing' },
  ]);
});

test('deduplicates apps by name', () => {
  const raw: StoreLeadsDomain = {
    name: 'shop.pl',
    apps: [
      { name: 'Klaviyo', state: 'Active' },
      { name: 'klaviyo', state: 'Active' },
    ],
  };
  assert.equal(mapDomain(raw)!.apps.length, 1);
});

test('keeps apps whose state is absent rather than guessing they are removed', () => {
  const raw: StoreLeadsDomain = { name: 'shop.pl', apps: [{ name: 'Klaviyo' }] };
  assert.equal(mapDomain(raw)!.apps.length, 1);
});

test('reads theme as an object or a bare string', () => {
  assert.deepEqual(mapDomain(milla!)!.theme, {
    name: 'streamline',
    version: '3.2.1',
    style: null,
    vendor: null,
  });

  const stringTheme = mapDomain({ name: 'shop.pl', theme: 'Debut' })!;
  assert.equal(stringTheme.store.theme_name, 'Debut');
  assert.equal(stringTheme.store.theme_version, null);
});

test('normalises platform and country casing', () => {
  const result = mapDomain({ name: 'shop.pl', platform: 'Shopify', country_code: 'pl' })!;
  assert.equal(result.store.platform, 'shopify');
  assert.equal(result.store.country, 'PL');
});

test('coerces numeric strings and leaves absent fields null', () => {
  const result = mapDomain({
    name: 'shop.pl',
    estimated_sales: '4500000' as unknown as number,
    estimated_visits: '11000' as unknown as number,
  })!;
  assert.equal(result.store.revenue_estimate, 4500000);
  assert.equal(result.store.traffic_estimate, 11000);
  assert.equal(result.store.apps_count, null, 'no apps means null, not 0');
  assert.equal(result.store.first_seen_run_id, null);
});

test('growth_rate is always null — StoreLeads exposes no growth attribute', () => {
  for (const raw of domains) {
    assert.equal(mapDomain(raw)!.store.growth_rate, null);
  }
});

test('extracts technologies and categories as plain strings', () => {
  const result = mapDomain(keyshorts!)!;
  assert.deepEqual(result.technologies, ['Apple Pay', 'Arrive', 'Cloudflare']);
  assert.deepEqual(result.categories, ['/Computers/Computer Hardware/Laptops & Notebooks']);
});

test('falls back to platform_domain when name is unusable', () => {
  const raw: StoreLeadsDomain = { name: null, platform_domain: 'millanova.myshopify.com' };
  assert.equal(mapDomain(raw)!.store.domain, 'millanova.myshopify.com');
});

test('returns null when no usable domain exists', () => {
  assert.equal(mapDomain({}), null);
  assert.equal(mapDomain({ name: null, platform_domain: null }), null);
  assert.equal(mapDomain({ name: 'not a domain' }), null);
});

test('rejects garbage numeric values instead of storing NaN', () => {
  const store = mapDomain({
    name: 'shop.pl',
    rank: 'abc' as unknown as number,
    estimated_sales: Number.NaN,
    product_count: Number.POSITIVE_INFINITY,
  })!.store;
  assert.equal(store.rank, null);
  assert.equal(store.revenue_estimate, null);
  assert.equal(store.products_count, null);
});

test('maps every store in the recorded page', () => {
  const { mapped, skipped } = mapDomains(domains, { runId: 1 });
  assert.equal(skipped, 0);
  assert.deepEqual(
    mapped.map((m) => m.store.domain),
    ['itsmilla.com', 'businessmodelcanvastemplate.com', 'keyshorts.com'],
  );
  assert.deepEqual(
    mapped.map((m) => m.store.rank),
    [3178, 7590, 12591],
    'ranks stay ascending, as sort=rank returned them',
  );
});

test('reports rows it could not map', () => {
  const { mapped, skipped } = mapDomains([{ name: null }, milla!], {});
  assert.equal(mapped.length, 1);
  assert.equal(skipped, 1);
});
