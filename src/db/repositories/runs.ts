import { execute, queryAll, queryOne, type Database, type SqlParam } from '../client.js';
import type { RunRow } from '../types.js';
import { assertTransition, RUN_TRANSITIONS, type RunStatus } from '../../pipeline/status.js';
import { nowIso } from '../../lib/time.js';

export function createRun(country: string, batchSize: number, db?: Database): RunRow {
  const { lastInsertRowid } = execute(
    'INSERT INTO runs (status, country, batch_size) VALUES (?, ?, ?)',
    ['PENDING', country, batchSize],
    db,
  );
  return getRun(lastInsertRowid, db)!;
}

export function getRun(id: number, db?: Database): RunRow | undefined {
  return queryOne<RunRow>('SELECT * FROM runs WHERE id = ?', [id], db);
}

export function listRuns(limit = 50, db?: Database): RunRow[] {
  return queryAll<RunRow>('SELECT * FROM runs ORDER BY id DESC LIMIT ?', [limit], db);
}

export function setRunStatus(
  id: number,
  status: RunStatus,
  options: { error?: string } = {},
  db?: Database,
): void {
  const run = getRun(id, db);
  if (!run) throw new Error(`Run ${id} not found`);
  assertTransition(RUN_TRANSITIONS, run.status, status, 'run');

  const finished = status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
  const params: SqlParam[] = [status, finished ? nowIso() : null, options.error ?? null, id];
  execute(
    `UPDATE runs
        SET status = ?,
            finished_at = COALESCE(?, finished_at),
            error = COALESCE(?, error)
      WHERE id = ?`,
    params,
    db,
  );
}

/**
 * Marks runs left RUNNING by a process that is gone.
 *
 * A run that is killed (Ctrl+C, crash, `kill -9`) never reaches its own error
 * handler, so its row stays RUNNING and blocks every later run. Only one
 * pipeline runs at a time, so any RUNNING row at startup is by definition
 * abandoned unless it belongs to the caller.
 */
export function markAbandonedRuns(exceptRunId: number | null, db?: Database): number {
  const rows = queryAll<{ id: number }>(
    'SELECT id FROM runs WHERE status = ? AND id IS NOT ?',
    ['RUNNING', exceptRunId],
    db,
  );
  for (const row of rows) {
    execute(
      'UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?',
      ['FAILED', nowIso(), 'abandoned: the process that started this run is gone', row.id],
      db,
    );
  }
  return rows.length;
}

export function attachStoreToRun(runId: number, storeId: number, db?: Database): void {
  execute(
    'INSERT OR IGNORE INTO run_stores (run_id, store_id) VALUES (?, ?)',
    [runId, storeId],
    db,
  );
}

export function listRunStoreIds(runId: number, db?: Database): number[] {
  return queryAll<{ store_id: number }>(
    'SELECT store_id FROM run_stores WHERE run_id = ? ORDER BY added_at',
    [runId],
    db,
  ).map((r) => r.store_id);
}
