import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getConfig } from '../config/index.js';

export type Database = DatabaseSync;

let db: Database | undefined;

function applyPragmas(handle: Database): void {
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA synchronous = NORMAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');
}

/** Opens (once) the project database. `:memory:` is used by tests. */
export function getDb(): Database {
  if (!db) {
    const file = getConfig().paths.database;
    mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    applyPragmas(db);
  }
  return db;
}

/** Fresh in-memory database — for tests only. */
export function createMemoryDb(): Database {
  const handle = new DatabaseSync(':memory:');
  applyPragmas(handle);
  return handle;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 * Nested calls reuse the outer transaction via SAVEPOINT.
 */
let depth = 0;

export function transaction<T>(fn: () => T, handle: Database = getDb()): T {
  const isNested = depth > 0;
  const name = `sp_${depth}`;

  handle.exec(isNested ? `SAVEPOINT ${name}` : 'BEGIN');
  depth += 1;
  try {
    const result = fn();
    handle.exec(isNested ? `RELEASE ${name}` : 'COMMIT');
    return result;
  } catch (error) {
    if (isNested) {
      // ROLLBACK TO leaves the savepoint in place; release it so it does not leak.
      handle.exec(`ROLLBACK TO ${name}`);
      handle.exec(`RELEASE ${name}`);
    } else {
      handle.exec('ROLLBACK');
    }
    throw error;
  } finally {
    depth -= 1;
  }
}

/**
 * node:sqlite returns `Record<string, SQLOutputValue>`; every read goes through
 * these helpers so the row-shape cast lives in exactly one place.
 */
export function queryAll<T>(sql: string, params: SqlParam[] = [], handle: Database = getDb()): T[] {
  return handle.prepare(sql).all(...params) as unknown as T[];
}

export function queryOne<T>(
  sql: string,
  params: SqlParam[] = [],
  handle: Database = getDb(),
): T | undefined {
  return handle.prepare(sql).get(...params) as unknown as T | undefined;
}

export function execute(
  sql: string,
  params: SqlParam[] = [],
  handle: Database = getDb(),
): { changes: number; lastInsertRowid: number } {
  const result = handle.prepare(sql).run(...params);
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

export type SqlParam = string | number | bigint | null | Uint8Array;
