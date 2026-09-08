import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, queryAll, type Database } from './client.js';
import { migrate } from './migrate.js';
import { createRun, attachStoreToRun } from './repositories/runs.js';
import { upsertStore, saveSnapshot } from './repositories/stores.js';
import { saveStoreApps, saveThemeInfo } from './repositories/storeFacts.js';
import { saveCursor, cursorKey, getCursor } from './repositories/cursors.js';
import { startStep, finishStep } from './repositories/stepLogs.js';
import { dataTables, resetDatabase } from './reset.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

function populated(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);

  const run = createRun('PL', 10, db);
  const { store } = upsertStore({ domain: 'a.pl', url: 'https://a.pl', rank: 1 }, db);
  attachStoreToRun(run.id, store.id, db);
  saveSnapshot(store.id, run.id, { rank: 1 }, 'storeleads', db);
  saveStoreApps(store.id, [{ name: 'Klaviyo', category: 'email marketing' }], db);
  saveThemeInfo(store.id, { name: 'Dawn', currentVersion: '2.1.0' }, db);
  saveCursor(cursorKey('storeleads', 'PL'), 42, 999, db);
  finishStep(startStep({ runId: run.id, storeId: store.id, step: 'audit' }, 1, db), 'OK', {}, db);
  return db;
}

function countAll(db: Database): number {
  return dataTables(db).reduce(
    (total, table) =>
      total + (queryAll<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`, [], db)[0]?.n ?? 0),
    0,
  );
}

test('lists data tables without the migration bookkeeping', () => {
  const db = populated();
  const tables = dataTables(db);
  assert.ok(tables.includes('stores'));
  assert.ok(tables.includes('runs'));
  assert.ok(!tables.includes('_migrations'), 'migration history must survive a reset');
  assert.ok(!tables.some((t) => t.startsWith('sqlite_')));
});

test('empties every data table', () => {
  const db = populated();
  assert.ok(countAll(db) > 0, 'fixture precondition');

  const summary = resetDatabase(db);
  assert.equal(countAll(db), 0);
  assert.ok(summary.rowsDeleted > 0);
  assert.deepEqual(summary.tables, dataTables(db));
});

test('keeps the schema and the applied migrations', () => {
  const db = populated();
  const before = dataTables(db);
  // Counted rather than hardcoded, so a new migration file does not fail this test.
  const appliedBefore = queryAll<{ n: number }>('SELECT COUNT(*) AS n FROM _migrations', [], db)[0]
    ?.n;
  resetDatabase(db);

  assert.deepEqual(dataTables(db), before, 'tables still exist');
  assert.ok(appliedBefore && appliedBefore > 0, 'the fixture must have applied migrations');
  assert.equal(
    queryAll<{ n: number }>('SELECT COUNT(*) AS n FROM _migrations', [], db)[0]?.n,
    appliedBefore,
    'migrations must not re-run after a reset',
  );
  assert.equal(migrate(db, MIGRATIONS_DIR).length, 0);
});

test('restarts ids from 1 so a reset database looks fresh', () => {
  const db = populated();
  resetDatabase(db);

  const run = createRun('PL', 10, db);
  assert.equal(run.id, 1);
  assert.equal(upsertStore({ domain: 'b.pl', url: 'https://b.pl' }, db).store.id, 1);
});

test('clears the batch cursor so fetching starts from the top again', () => {
  const db = populated();
  assert.equal(getCursor(cursorKey('storeleads', 'PL'), db).offset_val, 42);

  resetDatabase(db);
  assert.equal(getCursor(cursorKey('storeleads', 'PL'), db).offset_val, 0);
});

test('leaves foreign key enforcement on afterwards', () => {
  const db = populated();
  resetDatabase(db);

  const enabled = queryAll<{ foreign_keys: number }>('PRAGMA foreign_keys', [], db)[0];
  assert.equal(enabled?.foreign_keys, 1);

  // Proof it is really enforced again.
  assert.throws(
    () => db.prepare('INSERT INTO audits (store_id, run_id) VALUES (999, 999)').run(),
    /FOREIGN KEY/,
  );
});

test('resetting an already empty database is a no-op', () => {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  const summary = resetDatabase(db);
  assert.equal(summary.rowsDeleted, 0);
  assert.equal(countAll(db), 0);
});
