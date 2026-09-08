import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, queryAll, type Database } from '../../db/client.js';
import { migrate } from '../../db/migrate.js';
import { createRun, listRunStoreIds } from '../../db/repositories/runs.js';
import { cursorKey, getCursor, saveCursor } from '../../db/repositories/cursors.js';
import { findStoreByDomain, upsertStore } from '../../db/repositories/stores.js';
import { getThemeInfo, listStoreApps } from '../../db/repositories/storeFacts.js';
import { silentLogger } from '../../lib/logger.js';
import type {
  StoreLeadsDomain,
  StoreLeadsListResponse,
} from '../../collectors/storeleads/types.js';
import type { ListDomainsParams } from '../../collectors/storeleads/client.js';
import {
  assertFilterApplied,
  createFetchStoresStep,
  fetchStores,
  type DomainSource,
} from './fetchStores.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'db', 'migrations');

function freshDb(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  return db;
}

/** Serves a fixed list of domains, paginated exactly like the real API. */
function stubSource(domains: StoreLeadsDomain[]) {
  const calls: ListDomainsParams[] = [];
  const source: DomainSource = {
    listDomains: (params) => {
      calls.push(params);
      const pageSize = params.pageSize ?? 50;
      const start = (params.page ?? 0) * pageSize;
      const slice = domains.slice(start, start + pageSize);
      return Promise.resolve({
        domains: slice,
        page_size: pageSize,
        total: domains.length,
        has_next_page: start + pageSize < domains.length,
      } satisfies StoreLeadsListResponse);
    },
  };
  return { source, calls };
}

function domain(name: string, rank: number): StoreLeadsDomain {
  return {
    name,
    merchant_name: name.replace('.pl', ''),
    platform: 'shopify',
    country_code: 'PL',
    rank,
    estimated_sales: rank * 1000,
    theme: { name: 'Dawn', version: '2.1.0' },
    apps: [{ name: 'Klaviyo', state: 'Active', categories: ['email marketing'] }],
  };
}

function ctxFor(db: Database, runId: number) {
  return { runId, db, logger: silentLogger() };
}

test('fetches a batch, attaches stores to the run and records facts', async () => {
  const db = freshDb();
  const run = createRun('PL', 3, db);
  const { source, calls } = stubSource([domain('a.pl', 1), domain('b.pl', 2), domain('c.pl', 3)]);

  const result = await fetchStores(ctxFor(db, run.id), {
    client: source,
    batchSize: 3,
    pageSize: 50,
  });

  assert.equal(result.created, 3);
  assert.equal(result.duplicates, 0);
  assert.equal(calls[0]!.country, 'PL');
  assert.equal(listRunStoreIds(run.id, db).length, 3);

  const store = findStoreByDomain('a.pl', db)!;
  assert.equal(store.name, 'a');
  assert.equal(store.first_seen_run_id, run.id);
  assert.deepEqual(
    listStoreApps(store.id, db).map((a) => a.name),
    ['Klaviyo'],
  );
  assert.equal(getThemeInfo(store.id, db)?.current_version, '2.1.0');
});

test('stores the raw payload as a snapshot (task 1-08)', async () => {
  const db = freshDb();
  const run = createRun('PL', 1, db);
  const { source } = stubSource([domain('a.pl', 1)]);

  await fetchStores(ctxFor(db, run.id), { client: source, batchSize: 1 });

  const snapshots = queryAll<{ payload: string; source: string }>(
    'SELECT payload, source FROM store_snapshots',
    [],
    db,
  );
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]!.source, 'storeleads');
  assert.equal((JSON.parse(snapshots[0]!.payload) as StoreLeadsDomain).rank, 1);
});

test('skips duplicates and keeps paging until the batch is full (task 1-06)', async () => {
  const db = freshDb();
  const run = createRun('PL', 2, db);

  // b.pl is already known from an earlier run.
  upsertStore({ domain: 'b.pl', url: 'https://b.pl' }, db);

  const { source } = stubSource([domain('a.pl', 1), domain('b.pl', 2), domain('c.pl', 3)]);
  const result = await fetchStores(ctxFor(db, run.id), {
    client: source,
    batchSize: 2,
    pageSize: 50,
  });

  assert.equal(result.created, 2);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(listRunStoreIds(run.id, db).length, 2, 'the duplicate is not attached');
  assert.equal(result.cursorAfter, 3, 'all three rows were consumed');
});

test('a duplicate does not overwrite the existing store', async () => {
  const db = freshDb();
  const run = createRun('PL', 1, db);
  const existing = upsertStore({ domain: 'a.pl', url: 'https://a.pl', rank: 999 }, db);

  const { source } = stubSource([domain('a.pl', 1), domain('b.pl', 2)]);
  await fetchStores(ctxFor(db, run.id), { client: source, batchSize: 1 });

  assert.equal(findStoreByDomain('a.pl', db)!.rank, 999, 'existing data is preserved');
  assert.equal(findStoreByDomain('a.pl', db)!.id, existing.store.id);
});

test('the cursor makes the next run continue where this one stopped (task 1-04)', async () => {
  const db = freshDb();
  const all = [1, 2, 3, 4, 5].map((n) => domain(`s${n}.pl`, n));
  const { source } = stubSource(all);

  const first = createRun('PL', 2, db);
  const r1 = await fetchStores(ctxFor(db, first.id), {
    client: source,
    batchSize: 2,
    pageSize: 50,
  });
  assert.equal(r1.cursorBefore, 0);
  assert.equal(r1.cursorAfter, 2);

  const second = createRun('PL', 2, db);
  const r2 = await fetchStores(ctxFor(db, second.id), {
    client: source,
    batchSize: 2,
    pageSize: 50,
  });
  assert.equal(r2.cursorBefore, 2);
  assert.equal(r2.cursorAfter, 4);

  const domains = listRunStoreIds(second.id, db).map(
    (id) =>
      queryAll<{ domain: string }>('SELECT domain FROM stores WHERE id = ?', [id], db)[0]!.domain,
  );
  assert.deepEqual(domains, ['s3.pl', 's4.pl'], 'no overlap with the first run');
  assert.equal(getCursor(cursorKey('storeleads', 'PL'), db).offset_val, 4);
});

test('resumes mid-page when the cursor is not on a page boundary', async () => {
  const db = freshDb();
  const all = [1, 2, 3, 4, 5, 6].map((n) => domain(`s${n}.pl`, n));
  const { source, calls } = stubSource(all);

  // Pretend a previous run consumed 3 rows with a page size of 2.
  saveCursor(cursorKey('storeleads', 'PL'), 3, 3, db);

  const run = createRun('PL', 2, db);
  await fetchStores(ctxFor(db, run.id), { client: source, batchSize: 2, pageSize: 2 });

  assert.equal(calls[0]!.page, 1, 'row 3 lives on page 1 with page_size 2');
  const fetched = listRunStoreIds(run.id, db).map(
    (id) =>
      queryAll<{ domain: string }>('SELECT domain FROM stores WHERE id = ?', [id], db)[0]!.domain,
  );
  assert.deepEqual(fetched, ['s4.pl', 's5.pl'], 'row 3 (s3.pl) is not fetched twice');
});

test('pages through the API until the batch target is met', async () => {
  const db = freshDb();
  const all = [1, 2, 3, 4, 5].map((n) => domain(`s${n}.pl`, n));
  const { source, calls } = stubSource(all);

  const run = createRun('PL', 5, db);
  const result = await fetchStores(ctxFor(db, run.id), {
    client: source,
    batchSize: 5,
    pageSize: 2,
  });

  assert.equal(result.created, 5);
  assert.deepEqual(
    calls.map((c) => c.page),
    [0, 1, 2],
  );
});

test('stops cleanly when StoreLeads runs out of results', async () => {
  const db = freshDb();
  const { source } = stubSource([domain('a.pl', 1)]);
  const run = createRun('PL', 10, db);

  const result = await fetchStores(ctxFor(db, run.id), {
    client: source,
    batchSize: 10,
    pageSize: 50,
  });

  assert.equal(result.created, 1);
  assert.equal(result.exhausted, true);
});

test('skips rows without a usable domain instead of failing the batch', async () => {
  const db = freshDb();
  const { source } = stubSource([
    { name: null, merchant_name: 'Broken' },
    domain('a.pl', 1),
    { name: 'not a domain' },
  ]);
  const run = createRun('PL', 1, db);

  const result = await fetchStores(ctxFor(db, run.id), { client: source, batchSize: 1 });
  assert.equal(result.unusable, 1, 'the broken row before a.pl is counted');
  assert.equal(result.created, 1);
});

test('respects maxPages so an all-duplicate feed cannot loop forever', async () => {
  const db = freshDb();
  const all = Array.from({ length: 20 }, (_, i) => domain(`s${i}.pl`, i));
  for (const d of all) upsertStore({ domain: d.name!, url: `https://${d.name!}` }, db);

  const { source, calls } = stubSource(all);
  const run = createRun('PL', 5, db);

  const result = await fetchStores(ctxFor(db, run.id), {
    client: source,
    batchSize: 5,
    pageSize: 2,
    maxPages: 3,
  });

  assert.equal(result.created, 0);
  assert.equal(result.duplicates, 6);
  assert.equal(calls.length, 3, 'stopped at maxPages');
});

test('the step fails loudly when a full feed yields nothing new', async () => {
  const db = freshDb();
  const all = Array.from({ length: 6 }, (_, i) => domain(`s${i}.pl`, i));
  for (const d of all) upsertStore({ domain: d.name!, url: `https://${d.name!}` }, db);

  const { source } = stubSource(all);
  const step = createFetchStoresStep({ client: source, batchSize: 5, pageSize: 2, maxPages: 3 });
  const run = createRun('PL', 5, db);

  await assert.rejects(
    step.run({
      ...ctxFor(db, run.id),
      store: null,
      force: false,
      signal: new AbortController().signal,
    }),
    /no new stores/,
  );
});

test('the step reports its counters as step metadata', async () => {
  const db = freshDb();
  const { source } = stubSource([domain('a.pl', 1), domain('b.pl', 2)]);
  const step = createFetchStoresStep({ client: source, batchSize: 2 });
  const run = createRun('PL', 2, db);

  const outcome = await step.run({
    ...ctxFor(db, run.id),
    store: null,
    force: false,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.status, 'OK');
  assert.equal((outcome.meta as { created: number }).created, 2);
});

test("batch size defaults to the run's own batch_size (CLI --limit)", async () => {
  const db = freshDb();
  const all = [1, 2, 3, 4, 5].map((n) => domain(`s${n}.pl`, n));
  const { source } = stubSource(all);

  const run = createRun('PL', 2, db); // --limit 2
  const result = await fetchStores(ctxFor(db, run.id), { client: source });

  assert.equal(result.created, 2, 'honours the run batch size without an explicit option');
});

test('passes the platform filter through to the client', async () => {
  const db = freshDb();
  const run = createRun('PL', 1, db);
  const { source, calls } = stubSource([domain('a.pl', 1)]);

  await fetchStores(ctxFor(db, run.id), { client: source, batchSize: 1, platform: 'shopify' });
  assert.equal(calls[0]!.platform, 'shopify');
});

test('omits the platform filter when it is blank', async () => {
  const db = freshDb();
  const run = createRun('PL', 1, db);
  const { source, calls } = stubSource([domain('a.pl', 1)]);

  await fetchStores(ctxFor(db, run.id), { client: source, batchSize: 1, platform: '' });
  assert.equal(calls[0]!.platform, undefined);
});

test('detects a country filter that the API silently ignored', () => {
  // What `f:country=PL` actually does: 200 OK, unfiltered US results.
  const unfiltered = [
    { country_code: 'US', platform: 'shopify' },
    { country_code: 'US', platform: 'shopify' },
    { country_code: 'GB', platform: 'shopify' },
  ];
  assert.throws(
    () => assertFilterApplied(unfiltered, 'PL', 'shopify'),
    /country filter did not apply: 3\/3/,
  );
});

test('detects a platform filter that the API silently ignored', () => {
  const wrongPlatform = [
    { country_code: 'PL', platform: 'woocommerce' },
    { country_code: 'PL', platform: 'wix' },
  ];
  assert.throws(
    () => assertFilterApplied(wrongPlatform, 'PL', 'shopify'),
    /platform filter did not apply: 2\/2/,
  );
});

test('tolerates a minority of mislabelled rows', () => {
  const mostlyRight = [
    { country_code: 'PL', platform: 'shopify' },
    { country_code: 'PL', platform: 'shopify' },
    { country_code: 'DE', platform: 'shopify' },
  ];
  assert.doesNotThrow(() => assertFilterApplied(mostlyRight, 'PL', 'shopify'));
});

test('skips the guard when the payload carries no country or platform', () => {
  assert.doesNotThrow(() => assertFilterApplied([{}, {}], 'PL', 'shopify'));
  assert.doesNotThrow(() => assertFilterApplied([], 'PL', 'shopify'));
});

test('a silently ignored filter aborts the fetch rather than storing wrong data', async () => {
  const db = freshDb();
  const run = createRun('PL', 2, db);
  const usStores: StoreLeadsDomain[] = [
    { name: 'us1.com', country_code: 'US', platform: 'shopify', rank: 1 },
    { name: 'us2.com', country_code: 'US', platform: 'shopify', rank: 2 },
  ];
  const { source } = stubSource(usStores);

  await assert.rejects(
    fetchStores(ctxFor(db, run.id), { client: source, batchSize: 2 }),
    /country filter did not apply/,
  );
  assert.equal(listRunStoreIds(run.id, db).length, 0, 'nothing was written');
});
