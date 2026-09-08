import { execute, getDb, queryAll, transaction, type Database } from './client.js';

/**
 * Empties every data table while keeping the schema and the applied-migration
 * history. Used by `pipeline db reset` to get back to a clean slate without
 * deleting the file — anything holding the database open (the dashboard) keeps
 * working across the reset.
 */

/** Tables that describe the database itself rather than pipeline data. */
const PRESERVED = new Set(['_migrations', 'sqlite_sequence']);

export function dataTables(db: Database = getDb()): string[] {
  return queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    [],
    db,
  )
    .map((row) => row.name)
    .filter((name) => !PRESERVED.has(name))
    .sort();
}

export interface ResetSummary {
  tables: string[];
  rowsDeleted: number;
}

export function resetDatabase(db: Database = getDb()): ResetSummary {
  const tables = dataTables(db);

  // Deleting in dependency order would be fragile as the schema grows; turning
  // enforcement off is safe here because every table is emptied together.
  // PRAGMA foreign_keys is a no-op inside a transaction, so it goes outside.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    return transaction(() => {
      let rowsDeleted = 0;
      for (const table of tables) {
        rowsDeleted += execute(`DELETE FROM "${table}"`, [], db).changes;
      }
      // Restart AUTOINCREMENT ids from 1 so a fresh database looks fresh.
      const hasSequence = queryAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
        [],
        db,
      ).length;
      if (hasSequence) execute('DELETE FROM sqlite_sequence', [], db);
      return { tables, rowsDeleted };
    }, db);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
