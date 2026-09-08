import { DatabaseSync } from "node:sqlite";

/**
 * Read-only access to the pipeline database.
 *
 * The dashboard deliberately does not import the pipeline's repositories: those
 * mutate state and would be bundled into the Next server. Row *types* are shared
 * from `@core/db/types` — type-only imports are erased, so nothing crosses at runtime.
 *
 * The file location comes from the pipeline config via `next.config.ts`.
 */
const DB_PATH = process.env.STORELEAD_DB_PATH;

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (!DB_PATH) {
    throw new Error(
      "STORELEAD_DB_PATH is not set — it is injected by next.config.ts from the pipeline config.",
    );
  }
  if (!db) {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
  }
  return db;
}

export type SqlParam = string | number | null;

/**
 * Rows come back from `node:sqlite` with a null prototype, and React refuses to
 * pass such an object from a Server Component to a Client Component: "Only plain
 * objects, and a few built-ins, can be passed". Copying them here fixes the whole
 * class of bug at the one place rows enter the app, rather than at each boundary
 * where somebody remembers.
 */
function plain<T>(row: T): T {
  return { ...row };
}

export function queryAll<T>(sql: string, params: SqlParam[] = []): T[] {
  return (
    getDb()
      .prepare(sql)
      .all(...params) as unknown as T[]
  ).map(plain);
}

export function queryOne<T>(sql: string, params: SqlParam[] = []): T | undefined {
  const row = getDb()
    .prepare(sql)
    .get(...params) as unknown as T | undefined;
  return row === undefined ? undefined : plain(row);
}

/** True when the pipeline has created the schema; false before the first migration. */
export function databaseReady(): boolean {
  try {
    return Boolean(
      queryOne<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='runs'",
      ),
    );
  } catch {
    return false;
  }
}
