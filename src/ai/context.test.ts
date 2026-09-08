import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { test } from 'node:test';
import { createMemoryDb, execute, type Database } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { createAudit, finishAudit, saveIssues } from '../db/repositories/audits.js';
import { saveStoreApps, saveThemeInfo } from '../db/repositories/storeFacts.js';
import { upsertStore } from '../db/repositories/stores.js';
import type { StoreRow } from '../db/types.js';
import { buildStoreContext, serializeContext, CONTEXT_VERSION } from './context.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'db', 'migrations');
/** Big enough that nothing is trimmed unless a test asks for it. */
const ROOMY = 1_000_000;

function freshDb(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  return db;
}

function makeStore(db: Database, overrides: Record<string, unknown> = {}): StoreRow {
  return upsertStore(
    {
      domain: 'sklep.pl',
      url: 'https://sklep.pl',
      name: 'Sklep',
      country: 'PL',
      platform: 'shopify',
      rank: 42,
      revenue_estimate: 500_000,
      traffic_estimate: 90_000,
      growth_rate: 0.12,
      products_count: 240,
      apps_count: 3,
      theme_name: 'Dawn',
      theme_version: '2.4.0',
      ...overrides,
    },
    db,
  ).store;
}

function auditWith(
  db: Database,
  storeId: number,
  issues: Parameters<typeof saveIssues>[2],
  pages: unknown = { pages: [], keyUrls: null, botProtection: { vendor: null, signal: null } },
): number {
  const audit = createAudit(storeId, null, db);
  saveIssues(audit.id, storeId, issues, db);
  finishAudit(audit.id, { status: 'OK', pages, seo: { page: null, site: null } }, db);
  return audit.id;
}

function issue(overrides: Partial<Parameters<typeof saveIssues>[2][number]> = {}) {
  return {
    page: 'homepage' as const,
    category: 'technical' as const,
    severity: 'MAJOR' as const,
    title: 'Broken image',
    evidence: [{ selector: 'img.hero', url: 'https://sklep.pl/a.png', status: 404 }],
    ...overrides,
  };
}

test('the bundle carries business, theme, apps, pagespeed and audit facts', () => {
  const db = freshDb();
  const store = makeStore(db);
  saveThemeInfo(store.id, { name: 'Dawn', currentVersion: '2.4.0', architecture: 'os2' }, db);
  execute(
    `UPDATE theme_info SET latest_version = '15.3.0', version_gap = 13, age_months = 26,
            freshness = 'severely_outdated' WHERE store_id = ?`,
    [store.id],
    db,
  );
  saveStoreApps(
    store.id,
    [
      // StoreLeads' own category strings, not our group names.
      { name: 'Klaviyo', category: 'email marketing' },
      { name: 'Judge.me', category: 'product reviews' },
      { name: 'Mystery', category: null },
    ],
    db,
  );
  execute(
    `INSERT INTO pagespeed_results (store_id, strategy, performance, lcp_ms, cls, raw_json)
     VALUES (?, 'mobile', 31, 5400.0, 0.31, ?)`,
    [store.id, JSON.stringify({ lighthouse: 'x'.repeat(5000) })],
    db,
  );
  auditWith(db, store.id, [issue()]);

  const { context, json } = buildStoreContext(store, { db, maxBytes: ROOMY });

  assert.equal(context.version, CONTEXT_VERSION);
  assert.equal(context.store.domain, 'sklep.pl');
  assert.equal(context.business.revenueEstimate, 500_000);
  assert.equal(context.business.rank, 42);
  assert.equal(context.theme?.freshness, 'severely_outdated');
  assert.equal(context.theme?.versionGap, 13);
  assert.equal(context.apps?.total, 3);
  assert.equal(context.apps?.size, 'low');
  assert.equal(context.apps?.byGroup.marketing, 1);
  assert.equal(context.apps?.byGroup.reviews, 1);
  // An app StoreLeads left uncategorised counts as `other`, not as a group.
  assert.equal(context.apps?.byGroup.other, 1);
  // Zeros are carried: "no loyalty app" is a fact the model may use.
  assert.equal(context.apps?.byGroup.loyalty, 0);
  assert.equal(context.pagespeed[0]?.strategy, 'mobile');
  assert.equal(context.pagespeed[0]?.lcpMs, 5400);
  assert.equal(context.audit?.status, 'OK');
  assert.deepEqual(context.audit?.counts, { CRITICAL: 0, MAJOR: 1, MINOR: 0 });
  assert.ok(!json.includes('lighthouse'), 'the raw PageSpeed payload never reaches the prompt');
});

test('every issue keeps the database id the grounding guard checks against', () => {
  const db = freshDb();
  const store = makeStore(db);
  auditWith(db, store.id, [issue(), issue({ title: 'Slow', severity: 'MINOR' })]);

  const { context } = buildStoreContext(store, { db, maxBytes: ROOMY });
  const ids = context.audit!.issues.map((i) => i.id);

  assert.equal(ids.length, 2);
  assert.ok(
    ids.every((id) => Number.isInteger(id) && id > 0),
    'an issue without its row id could never be verified',
  );
  assert.deepEqual(context.audit!.issues[0]!.evidence, [
    { selector: 'img.hero', url: 'https://sklep.pl/a.png', status: 404 },
  ]);
});

test('serialisation drops nulls but keeps false and zero', () => {
  const db = freshDb();
  const store = makeStore(db, { name: null, revenue_estimate: null });
  auditWith(db, store.id, [], {
    pages: [
      {
        page: 'cart',
        viewport: 'desktop',
        url: 'https://sklep.pl/cart',
        availability: 'ok',
        httpStatus: 200,
        navigationMs: 0,
        screenshotId: null,
        checks: [],
        facts: { hasCheckoutButton: false, itemCount: null },
      },
    ],
    keyUrls: null,
    botProtection: { vendor: null, signal: null },
  });

  const json = serializeContext(buildStoreContext(store, { db, maxBytes: ROOMY }).context);
  const wire = JSON.parse(json) as Record<string, unknown>;

  assert.ok(!json.includes('null'), 'a null is an unknown, and an unknown is left out');
  assert.ok(!('name' in (wire.store as object)), 'unknown store name is omitted, not nulled');
  assert.equal(
    (wire.audit as { pages: { facts: { hasCheckoutButton: boolean } }[] }).pages[0]!.facts
      .hasCheckoutButton,
    false,
  );
  assert.equal((wire.audit as { pages: { navigationMs: number }[] }).pages[0]!.navigationMs, 0);
});

test('a store with no audit yet still produces a usable bundle', () => {
  const db = freshDb();
  const store = makeStore(db, { apps_count: null, theme_name: null, theme_version: null });

  const { context, bytes, overBudget } = buildStoreContext(store, { db, maxBytes: ROOMY });

  assert.equal(context.audit, null);
  assert.equal(context.theme, null);
  assert.equal(context.apps, null);
  assert.deepEqual(context.pagespeed, []);
  assert.equal(overBudget, false);
  assert.ok(bytes > 0);
});

test('the bundle is built from a named audit when one is given', () => {
  const db = freshDb();
  const store = makeStore(db);
  const first = auditWith(db, store.id, [issue({ title: 'Old finding' })]);
  auditWith(db, store.id, [issue({ title: 'New finding' })]);

  const latest = buildStoreContext(store, { db, maxBytes: ROOMY });
  const pinned = buildStoreContext(store, { db, auditId: first, maxBytes: ROOMY });

  assert.equal(latest.context.audit!.issues[0]!.title, 'New finding');
  assert.equal(pinned.context.audit!.issues[0]!.title, 'Old finding');
});

test('unreadable pages_json costs the facts in it, not the bundle', () => {
  const db = freshDb();
  const store = makeStore(db);
  const auditId = auditWith(db, store.id, [issue()]);
  execute(
    'UPDATE audits SET pages_json = ?, seo_json = ? WHERE id = ?',
    ['{oops', '{', auditId],
    db,
  );

  const { context } = buildStoreContext(store, { db, maxBytes: ROOMY });

  assert.deepEqual(context.audit?.pages, []);
  assert.deepEqual(context.audit?.seo, { page: null, site: null });
  assert.equal(context.audit?.issues.length, 1, 'the issues come from their own table');
});

test('a page reports how many checks ran, not only the ones that failed', () => {
  const db = freshDb();
  const store = makeStore(db);
  auditWith(db, store.id, [], {
    pages: [
      {
        page: 'product',
        viewport: 'desktop',
        url: 'https://sklep.pl/p/1',
        availability: 'ok',
        httpStatus: 200,
        navigationMs: 800,
        screenshotId: 7,
        checks: [
          { name: 'product.price', status: 'ok', error: null },
          { name: 'product.addToCart', status: 'failed', error: 'timeout' },
        ],
      },
    ],
    keyUrls: { homepage: 'https://sklep.pl/', collection: null, product: 'https://sklep.pl/p/1' },
    botProtection: { vendor: null, signal: null },
  });

  const { context } = buildStoreContext(store, { db, maxBytes: ROOMY });
  const page = context.audit!.pages[0]!;

  assert.deepEqual(page.checks, { run: 2, failed: 1 });
  assert.deepEqual(page.failedChecks, [{ name: 'product.addToCart', error: 'timeout' }]);
  assert.equal(page.screenshotId, 7);
  assert.equal(context.audit?.keyUrls?.product, 'https://sklep.pl/p/1');
});

test('bot protection is reported only when something actually blocked the audit', () => {
  const db = freshDb();
  const store = makeStore(db);
  auditWith(db, store.id, [], {
    pages: [],
    keyUrls: null,
    botProtection: { vendor: 'cloudflare', signal: 'cf-chl' },
  });

  const { context } = buildStoreContext(store, { db, maxBytes: ROOMY });
  assert.equal(context.audit?.botProtection?.vendor, 'cloudflare');

  const clean = freshDb();
  const other = makeStore(clean);
  auditWith(clean, other.id, []);
  assert.equal(
    buildStoreContext(other, { db: clean, maxBytes: ROOMY }).context.audit?.botProtection,
    undefined,
  );
});

test('the size limit is respected and what it cost is recorded', () => {
  const db = freshDb();
  const store = makeStore(db);
  const many = Array.from({ length: 60 }, (_, i) =>
    issue({
      title: `Finding ${i}`,
      severity: i === 0 ? 'CRITICAL' : i < 20 ? 'MAJOR' : 'MINOR',
      detail: 'd'.repeat(400),
      evidence: Array.from({ length: 8 }, (_, e) => ({
        selector: `#el-${e}`,
        text: 'x'.repeat(200),
      })),
    }),
  );
  auditWith(db, store.id, many);

  const maxBytes = 4_000;
  const { context, json, bytes, overBudget } = buildStoreContext(store, { db, maxBytes });

  assert.equal(overBudget, false);
  assert.ok(bytes <= maxBytes, `bundle is ${bytes} bytes, budget is ${maxBytes}`);
  assert.equal(bytes, Buffer.byteLength(json, 'utf8'));
  assert.equal(context.meta.truncated, true);
  assert.ok(context.meta.trimmed.length > 0, 'the bundle says which cuts were made');
  assert.ok(context.meta.issuesOmitted > 0);
  assert.deepEqual(
    context.audit!.counts,
    { CRITICAL: 1, MAJOR: 19, MINOR: 40 },
    'the counts describe the audit, not the surviving excerpt',
  );
});

test('trimming gives up the cheapest facts first and the worst findings last', () => {
  const db = freshDb();
  const store = makeStore(db);
  saveStoreApps(store.id, [{ name: 'Klaviyo', category: 'email marketing' }], db);
  auditWith(
    db,
    store.id,
    [
      issue({ severity: 'CRITICAL', title: 'Checkout is dead', detail: 'k'.repeat(300) }),
      issue({ severity: 'MINOR', title: 'Alt text missing', detail: 'm'.repeat(300) }),
    ],
    {
      pages: [
        {
          page: 'homepage',
          viewport: 'desktop',
          url: 'https://sklep.pl/',
          availability: 'ok',
          httpStatus: 200,
          navigationMs: 1200,
          screenshotId: 1,
          checks: [{ name: 'home.hero', status: 'failed', error: 'boom' }],
          facts: { links: { checked: 120, broken: 3 } },
        },
      ],
      keyUrls: null,
      botProtection: { vendor: null, signal: null },
    },
  );

  const untrimmed = buildStoreContext(store, { db, maxBytes: ROOMY }).bytes;
  // What is left when every trim step has run: the bundle cannot go below this.
  const floor = buildStoreContext(store, { db, maxBytes: 1 }).bytes;
  let sawCriticalAlone = false;

  // Every budget between the two, rather than one magic number, so the ordering
  // is asserted as a property and not as today's byte counts.
  for (let maxBytes = untrimmed; maxBytes >= floor; maxBytes -= 25) {
    const { context, bytes, overBudget } = buildStoreContext(store, { db, maxBytes });
    assert.equal(overBudget, false);
    assert.ok(bytes <= maxBytes, `${bytes} bytes exceeds a budget of ${maxBytes}`);

    const kept = context.audit!.issues;
    const minor = kept.filter((i) => i.severity === 'MINOR').length;
    const critical = kept.filter((i) => i.severity === 'CRITICAL').length;
    assert.ok(critical > 0 || minor === 0, 'a MINOR finding never outlives a CRITICAL one');
    if (critical === 1 && minor === 0) sawCriticalAlone = true;

    // Page facts and app names are the first things given up, never the last.
    if (kept.length < 2) {
      assert.equal(context.audit!.pages[0]!.facts, undefined);
      assert.equal(context.apps!.names, undefined);
    }
    assert.deepEqual(context.audit!.pages[0]!.checks, { run: 1, failed: 1 });
  }

  assert.ok(sawCriticalAlone, 'there is a budget at which only the CRITICAL finding fits');
});

test('an impossible budget is reported rather than silently blown', () => {
  const db = freshDb();
  const store = makeStore(db);
  auditWith(db, store.id, [issue()]);

  const { context, bytes, overBudget } = buildStoreContext(store, { db, maxBytes: 50 });

  assert.equal(overBudget, true);
  assert.ok(bytes > 50);
  assert.equal(context.audit!.issues.length, 0, 'everything droppable was dropped first');
  assert.equal(context.meta.truncated, true);
});
