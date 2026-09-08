import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { getDb, queryAll, type Database } from './client.js';

interface MigrationRow {
  name: string;
}

function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function pendingMigrations(db: Database, dir: string): string[] {
  const applied = new Set(
    queryAll<MigrationRow>('SELECT name FROM _migrations', [], db).map((r) => r.name),
  );
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f));
}

/**
 * Applies every not-yet-applied `.sql` file in migration order.
 * Each file runs in its own transaction, so a failure leaves the previous ones intact.
 */
export function migrate(db: Database = getDb(), dir = getConfig().paths.migrations): string[] {
  ensureMigrationsTable(db);
  const pending = pendingMigrations(db, dir);
  const log = logger();

  for (const file of pending) {
    const sql = readFileSync(path.join(dir, file), 'utf-8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
      log.info({ migration: file }, 'migration applied');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }

  if (pending.length === 0) log.info('database is up to date');
  return pending;
}
