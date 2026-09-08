import { execute, queryAll, queryOne, type Database } from '../client.js';
import type { StepLogRow } from '../types.js';
import type { StepStatus } from '../../pipeline/status.js';
import { nowIso } from '../../lib/time.js';

export interface StepKey {
  runId: number;
  storeId?: number | null;
  step: string;
}

export function startStep(key: StepKey, attempt: number, db?: Database): number {
  const { lastInsertRowid } = execute(
    'INSERT INTO step_logs (run_id, store_id, step, status, attempt) VALUES (?, ?, ?, ?, ?)',
    [key.runId, key.storeId ?? null, key.step, 'RUNNING', attempt],
    db,
  );
  return lastInsertRowid;
}

export function finishStep(
  id: number,
  status: StepStatus,
  options: { durationMs?: number; error?: string; meta?: unknown } = {},
  db?: Database,
): void {
  execute(
    `UPDATE step_logs
        SET status = ?, finished_at = ?, duration_ms = ?, error = ?, meta_json = ?
      WHERE id = ?`,
    [
      status,
      nowIso(),
      options.durationMs ?? null,
      options.error ?? null,
      options.meta === undefined ? null : JSON.stringify(options.meta),
      id,
    ],
    db,
  );
}

/** Latest recorded attempt of a step, used to decide whether it can be skipped (task 0-10). */
export function lastStepLog(key: StepKey, db?: Database): StepLogRow | undefined {
  return queryOne<StepLogRow>(
    `SELECT * FROM step_logs
      WHERE step = ? AND store_id IS ${key.storeId == null ? 'NULL' : '?'}
      ORDER BY id DESC LIMIT 1`,
    key.storeId == null ? [key.step] : [key.step, key.storeId],
    db,
  );
}

export function listRunSteps(runId: number, db?: Database): StepLogRow[] {
  return queryAll<StepLogRow>('SELECT * FROM step_logs WHERE run_id = ? ORDER BY id', [runId], db);
}
