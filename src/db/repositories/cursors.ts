import { execute, queryOne, type Database } from '../client.js';
import type { FetchCursorRow } from '../types.js';
import { nowIso } from '../../lib/time.js';

/**
 * Batch position for "the next N stores" (task 1-04).
 * Keyed per source+country so several markets can be walked independently.
 */
export function cursorKey(source: string, country: string): string {
  return `${source}:${country.toUpperCase()}`;
}

export function getCursor(key: string, db?: Database): FetchCursorRow {
  const row = queryOne<FetchCursorRow>('SELECT * FROM fetch_cursors WHERE key = ?', [key], db);
  return row ?? { key, offset_val: 0, last_rank: null, updated_at: nowIso() };
}

export function saveCursor(
  key: string,
  offset: number,
  lastRank: number | null,
  db?: Database,
): void {
  execute(
    `INSERT INTO fetch_cursors (key, offset_val, last_rank, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE
        SET offset_val = excluded.offset_val,
            last_rank  = excluded.last_rank,
            updated_at = excluded.updated_at`,
    [key, offset, lastRank, nowIso()],
    db,
  );
}

export function resetCursor(key: string, db?: Database): void {
  execute('DELETE FROM fetch_cursors WHERE key = ?', [key], db);
}
