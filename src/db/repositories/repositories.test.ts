import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, transaction, type Database } from '../client.js';
import { migrate } from '../migrate.js';
import { createRun, setRunStatus, attachStoreToRun, listRunStoreIds, getRun } from './runs.js';
import { upsertStore, setStoreStatus, listActiveStores, saveSnapshot, getStore } from './stores.js';
import { startStep, finishStep, lastStepLog } from './stepLogs.js';
import { cursorKey, getCursor, saveCursor, resetCursor } from './cursors.js';
import { getPagespeedResult, listPagespeedResults, savePagespeedResult } from './storeFacts.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'migrations');

function freshDb(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  return db;
}

test('run lifecycle enforces legal transitions', () => {
  const db = freshDb();
  const run = createRun('PL', 10, db);
  assert.equal(run.status, 'PENDING');

  setRunStatus(run.id, 'RUNNING', {}, db);
  setRunStatus(run.id, 'COMPLETED', {}, db);
  assert.ok(getRun(run.id, db)!.finished_at, 'finished_at should be stamped');

  assert.throws(() => setRunStatus(run.id, 'RUNNING', {}, db), /Illegal run transition/);
});

test('upsertStore deduplicates by normalised domain', () => {
  const db = freshDb();
  const run = createRun('PL', 10, db);

  const first = upsertStore({ domain: 'shop.pl', url: 'https://shop.pl', rank: 12 }, db);
  assert.equal(first.created, true);

  const second = upsertStore({ domain: 'shop.pl', url: 'https://shop.pl' }, db);
  assert.equal(second.created, false);
  assert.equal(second.store.id, first.store.id);
  assert.equal(second.store.rank, 12, 'existing data must not be overwritten');

  attachStoreToRun(run.id, first.store.id, db);
  attachStoreToRun(run.id, first.store.id, db);
  assert.deepEqual(listRunStoreIds(run.id, db), [first.store.id]);
});

test('store status machine blocks skipping stages and hides terminal stores', () => {
  const db = freshDb();
  const run = createRun('PL', 10, db);
  const { store } = upsertStore({ domain: 'a.pl', url: 'https://a.pl' }, db);
  attachStoreToRun(run.id, store.id, db);

  assert.throws(() => setStoreStatus(store.id, 'EMAIL_READY', undefined, db), /Illegal store/);

  setStoreStatus(store.id, 'AUDITED', undefined, db);
  assert.equal(listActiveStores(run.id, db).length, 1);

  setStoreStatus(store.id, 'SKIPPED', 'no contact found', db);
  assert.equal(listActiveStores(run.id, db).length, 0, 'terminal stores drop out of the queue');
  assert.equal(getStore(store.id, db)!.status_reason, 'no contact found');
});

test('snapshots are stored verbatim for re-analysis', () => {
  const db = freshDb();
  const { store } = upsertStore({ domain: 'b.pl', url: 'https://b.pl' }, db);
  saveSnapshot(store.id, null, { rank: 7, apps: ['klaviyo'] }, 'storeleads', db);

  const row = db.prepare('SELECT payload FROM store_snapshots').get() as { payload: string };
  assert.deepEqual(JSON.parse(row.payload), { rank: 7, apps: ['klaviyo'] });
});

test('step logs record the last attempt per store', () => {
  const db = freshDb();
  const run = createRun('PL', 10, db);
  const { store } = upsertStore({ domain: 'c.pl', url: 'https://c.pl' }, db);

  const first = startStep({ runId: run.id, storeId: store.id, step: 'audit' }, 1, db);
  finishStep(first, 'FAILED', { durationMs: 120, error: 'timeout' }, db);

  const second = startStep({ runId: run.id, storeId: store.id, step: 'audit' }, 2, db);
  finishStep(second, 'OK', { durationMs: 900, meta: { issues: 3 } }, db);

  const latest = lastStepLog({ runId: run.id, storeId: store.id, step: 'audit' }, db);
  assert.equal(latest?.status, 'OK');
  assert.equal(latest?.attempt, 2);
  assert.ok(latest, 'expected a step log');
  assert.deepEqual(JSON.parse(latest.meta_json ?? '{}'), { issues: 3 });
});

test('fetch cursor advances and resets', () => {
  const db = freshDb();
  const key = cursorKey('storeleads', 'pl');
  assert.equal(key, 'storeleads:PL');
  assert.equal(getCursor(key, db).offset_val, 0);

  saveCursor(key, 10, 1234, db);
  saveCursor(key, 20, 2345, db);
  assert.equal(getCursor(key, db).offset_val, 20);
  assert.equal(getCursor(key, db).last_rank, 2345);

  resetCursor(key, db);
  assert.equal(getCursor(key, db).offset_val, 0);
});

test('transaction wraps repository writes', () => {
  const db = freshDb();
  assert.throws(() =>
    transaction(() => {
      upsertStore({ domain: 'd.pl', url: 'https://d.pl' }, db);
      throw new Error('boom');
    }, db),
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stores').get()!.n, 0);
});

test('pagespeed results are stored one row per strategy', () => {
  const db = freshDb();
  const { store } = upsertStore({ domain: 'sklep.pl', url: 'https://sklep.pl' }, db);

  savePagespeedResult(store.id, { strategy: 'mobile', performance: 38, lcpMs: 6210 }, db);
  savePagespeedResult(store.id, { strategy: 'desktop', performance: 74, lcpMs: 2100 }, db);

  const rows = listPagespeedResults(store.id, db);
  assert.deepEqual(
    rows.map((r) => r.strategy),
    ['desktop', 'mobile'],
  );
  assert.equal(getPagespeedResult(store.id, 'mobile', db)!.performance, 38);
});

test('re-measuring overwrites the previous scores, nulls included', () => {
  const db = freshDb();
  const { store } = upsertStore({ domain: 'sklep.pl', url: 'https://sklep.pl' }, db);

  savePagespeedResult(
    store.id,
    { strategy: 'mobile', performance: 38, cls: 0.12, fetchedAt: '2026-08-01T00:00:00.000Z' },
    db,
  );
  // A later run whose analysis failed: no scores at all.
  savePagespeedResult(
    store.id,
    { strategy: 'mobile', raw: { error: 'DNS_FAILURE' }, fetchedAt: '2026-09-01T00:00:00.000Z' },
    db,
  );

  const row = getPagespeedResult(store.id, 'mobile', db)!;
  // Yesterday's 38 must not stand next to today's timestamp.
  assert.equal(row.performance, null);
  assert.equal(row.cls, null);
  assert.equal(row.fetched_at, '2026-09-01T00:00:00.000Z');
  assert.match(row.raw_json!, /DNS_FAILURE/);
  assert.equal(listPagespeedResults(store.id, db).length, 1);
});
