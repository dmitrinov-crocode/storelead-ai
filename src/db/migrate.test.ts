import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, transaction } from './client.js';
import { migrate } from './migrate.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

test('migrations apply and are idempotent', () => {
  const db = createMemoryDb();

  const applied = migrate(db, MIGRATIONS_DIR);
  assert.ok(applied.length > 0, 'expected at least one migration');
  assert.equal(migrate(db, MIGRATIONS_DIR).length, 0, 'second run should apply nothing');

  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((r) => r.name);

  for (const expected of [
    'runs',
    'stores',
    'run_stores',
    'store_snapshots',
    'fetch_cursors',
    'audits',
    'audit_issues',
    'screenshots',
    'pagespeed_results',
    'theme_info',
    'store_apps',
    'ai_analyses',
    'contacts',
    'emails',
    'step_logs',
  ]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  db.close();
});

test('foreign keys cascade and unique domain is enforced', () => {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);

  db.prepare("INSERT INTO runs (country, batch_size) VALUES ('PL', 10)").run();
  db.prepare("INSERT INTO stores (domain, url) VALUES ('shop.pl', 'https://shop.pl')").run();

  assert.throws(
    () =>
      db.prepare("INSERT INTO stores (domain, url) VALUES ('shop.pl', 'https://shop.pl')").run(),
    /UNIQUE/,
  );

  db.prepare('INSERT INTO audits (store_id, run_id) VALUES (1, 1)').run();
  db.prepare(
    `INSERT INTO audit_issues (audit_id, store_id, page, category, severity, title)
     VALUES (1, 1, 'product', 'technical', 'CRITICAL', 'Add to Cart does not work')`,
  ).run();

  db.prepare('DELETE FROM stores WHERE id = 1').run();
  const issues = db.prepare('SELECT COUNT(*) AS n FROM audit_issues').get() as { n: number };
  assert.equal(issues.n, 0, 'issues should cascade with the store');
  db.close();
});

test('transaction rolls back on throw, including nested savepoints', () => {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);

  assert.throws(() =>
    transaction(() => {
      db.prepare("INSERT INTO runs (country, batch_size) VALUES ('PL', 10)").run();
      throw new Error('boom');
    }, db),
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 0);

  transaction(() => {
    db.prepare("INSERT INTO runs (country, batch_size) VALUES ('PL', 10)").run();
    try {
      transaction(() => {
        db.prepare("INSERT INTO runs (country, batch_size) VALUES ('DE', 5)").run();
        throw new Error('inner boom');
      }, db);
    } catch {
      // inner rolled back, outer continues
    }
  }, db);

  const rows = db.prepare('SELECT country FROM runs').all() as { country: string }[];
  assert.deepEqual(
    rows.map((r) => r.country),
    ['PL'],
  );
  db.close();
});
