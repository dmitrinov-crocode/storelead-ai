import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, type Database } from '../client.js';
import { migrate } from '../migrate.js';
import { upsertStore } from './stores.js';
import {
  countEmailsByStatus,
  EmailTransitionError,
  getLatestEmail,
  listEarlierLetters,
  listEmails,
  saveEmail,
  setEmailStatus,
} from './emails.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'migrations');

function freshDb(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  return db;
}

function store(db: Database, domain = 'sklep.pl'): number {
  return upsertStore({ domain, url: `https://${domain}`, platform: 'shopify' }, db).store.id;
}

function draft(storeId: number, overrides: Record<string, unknown> = {}) {
  return {
    storeId,
    runId: null,
    subject: 'koszyk nie działa',
    body: 'Anna, koszyk nie działa na telefonie.',
    wordCount: 6,
    category: 'TECHNICAL_PROBLEMS',
    promptVersion: '1/ctx1',
    ...overrides,
  };
}

test('a draft is stored as version 1 in DRAFT', () => {
  const db = freshDb();
  const row = saveEmail(draft(store(db)), db);

  assert.equal(row.version, 1);
  assert.equal(row.status, 'DRAFT');
  assert.equal(row.word_count, 6);
  assert.equal(row.category, 'TECHNICAL_PROBLEMS');
  db.close();
});

test('every version is kept and the old one is retired', () => {
  const db = freshDb();
  const id = store(db);

  const first = saveEmail(draft(id, { status: 'QC_FAILED' }), db);
  const second = saveEmail(draft(id, { subject: 'druga próba' }), db);

  const rows = listEmails(id, db);
  assert.deepEqual(
    rows.map((r) => [r.version, r.status]),
    [
      [2, 'DRAFT'],
      [1, 'SKIPPED'],
    ],
  );
  // The rejected draft is the record of what QC refused — 5-09 reads exactly it.
  assert.equal(rows[1]?.id, first.id);
  assert.equal(getLatestEmail(id, db)?.id, second.id);
  db.close();
});

test('a human decision is never overwritten by a later draft', () => {
  const db = freshDb();
  const id = store(db);

  const ready = saveEmail(draft(id, { status: 'READY' }), db);
  setEmailStatus(ready.id, 'APPROVED', db);
  saveEmail(draft(id, { subject: 'nowa wersja' }), db);

  const rows = listEmails(id, db);
  assert.deepEqual(
    rows.map((r) => [r.version, r.status]),
    [
      [2, 'DRAFT'],
      [1, 'APPROVED'],
    ],
  );
  db.close();
});

test('approving is only possible from READY', () => {
  const db = freshDb();
  const row = saveEmail(draft(store(db)), db);

  // The one misclick in this flow that puts an unchecked claim in front of a
  // merchant: approving a letter that never passed QC.
  assert.throws(() => setEmailStatus(row.id, 'APPROVED', db), EmailTransitionError);
  assert.equal(getLatestEmail(row.store_id, db)?.status, 'DRAFT');
  db.close();
});

test('skipping is possible from any machine state', () => {
  const db = freshDb();
  for (const status of ['DRAFT', 'QC_FAILED', 'READY'] as const) {
    const id = store(db, `${status.toLowerCase()}.pl`);
    const row = saveEmail(draft(id, { status }), db);
    assert.equal(setEmailStatus(row.id, 'SKIPPED', db).status, 'SKIPPED');
  }
  db.close();
});

test('a terminal decision cannot be reversed', () => {
  const db = freshDb();
  const row = saveEmail(draft(store(db), { status: 'READY' }), db);
  setEmailStatus(row.id, 'APPROVED', db);

  assert.throws(() => setEmailStatus(row.id, 'SKIPPED', db), EmailTransitionError);
  db.close();
});

test('the QC verdict is stored as given and read back whole', () => {
  const db = freshDb();
  const verdict = { facts: 'PASS', tone: 'FAIL', reasons: ['too pushy'] };
  const row = saveEmail(draft(store(db), { qc: verdict, qcPassed: false, similarity: 0.42 }), db);

  assert.deepEqual(JSON.parse(row.qc_json!), verdict);
  assert.equal(row.qc_passed, 0);
  assert.equal(row.similarity, 0.42);
  db.close();
});

test('bodies of other stores are what the repetition detector compares against', () => {
  const db = freshDb();
  const mine = store(db, 'mine.pl');
  const other = store(db, 'other.pl');
  saveEmail(draft(mine, { body: 'moje pismo' }), db);
  saveEmail(draft(other, { body: 'cudze pismo' }), db);

  const bodies = listEarlierLetters({ excludeStoreId: mine }, db);
  assert.deepEqual(
    bodies.map((b) => b.body),
    ['cudze pismo'],
  );
  db.close();
});

test('counts by status feed the run report', () => {
  const db = freshDb();
  saveEmail(draft(store(db, 'a.pl'), { status: 'READY' }), db);
  saveEmail(draft(store(db, 'b.pl'), { status: 'QC_FAILED' }), db);

  assert.deepEqual(countEmailsByStatus(db), { READY: 1, QC_FAILED: 1 });
  db.close();
});
