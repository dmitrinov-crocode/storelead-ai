import { execute, queryAll, queryOne, type Database, type SqlParam } from '../client.js';
import type { StoreRow } from '../types.js';
import {
  assertTransition,
  STORE_TRANSITIONS,
  TERMINAL_STORE_STATUSES,
  type StoreStatus,
} from '../../pipeline/status.js';
import { nowIso } from '../../lib/time.js';

/** Fields the StoreLeads step supplies when creating a store (task 1-07). */
export interface StoreInput {
  domain: string;
  url: string;
  name?: string | null;
  country?: string | null;
  platform?: string | null;
  rank?: number | null;
  revenue_estimate?: number | null;
  traffic_estimate?: number | null;
  growth_rate?: number | null;
  products_count?: number | null;
  apps_count?: number | null;
  theme_name?: string | null;
  theme_version?: string | null;
  first_seen_run_id?: number | null;
}

const INSERT_COLUMNS = [
  'domain',
  'url',
  'name',
  'country',
  'platform',
  'rank',
  'revenue_estimate',
  'traffic_estimate',
  'growth_rate',
  'products_count',
  'apps_count',
  'theme_name',
  'theme_version',
  'first_seen_run_id',
] as const;

export function findStoreByDomain(domain: string, db?: Database): StoreRow | undefined {
  return queryOne<StoreRow>('SELECT * FROM stores WHERE domain = ?', [domain], db);
}

export function getStore(id: number, db?: Database): StoreRow | undefined {
  return queryOne<StoreRow>('SELECT * FROM stores WHERE id = ?', [id], db);
}

/**
 * Inserts a store, or returns the existing row when the normalised domain is
 * already known. `created` tells the caller whether this was a duplicate (task 1-06).
 */
export function upsertStore(
  input: StoreInput,
  db?: Database,
): { store: StoreRow; created: boolean } {
  const existing = findStoreByDomain(input.domain, db);
  if (existing) return { store: existing, created: false };

  const values: SqlParam[] = INSERT_COLUMNS.map((c) => (input[c] ?? null) as SqlParam);
  const { lastInsertRowid } = execute(
    `INSERT INTO stores (${INSERT_COLUMNS.join(', ')})
     VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`,
    values,
    db,
  );
  return { store: getStore(lastInsertRowid, db)!, created: true };
}

export function setStoreStatus(
  id: number,
  status: StoreStatus,
  reason?: string,
  db?: Database,
): void {
  const store = getStore(id, db);
  if (!store) throw new Error(`Store ${id} not found`);
  assertTransition(STORE_TRANSITIONS, store.status, status, 'store');
  execute(
    'UPDATE stores SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?',
    [status, reason ?? null, nowIso(), id],
    db,
  );
}

export function listStoresByStatus(status: StoreStatus, limit = 100, db?: Database): StoreRow[] {
  return queryAll<StoreRow>(
    'SELECT * FROM stores WHERE status = ? ORDER BY rank IS NULL, rank LIMIT ?',
    [status, limit],
    db,
  );
}

/** Stores that still have pipeline work left — everything except terminal states. */
export function listActiveStores(runId: number, db?: Database): StoreRow[] {
  const placeholders = TERMINAL_STORE_STATUSES.map(() => '?').join(', ');
  return queryAll<StoreRow>(
    `SELECT s.* FROM stores s
       JOIN run_stores rs ON rs.store_id = s.id
      WHERE rs.run_id = ? AND s.status NOT IN (${placeholders})
      ORDER BY s.rank IS NULL, s.rank`,
    [runId, ...TERMINAL_STORE_STATUSES],
    db,
  );
}

export function saveSnapshot(
  storeId: number,
  runId: number | null,
  payload: unknown,
  source = 'storeleads',
  db?: Database,
): void {
  execute(
    'INSERT INTO store_snapshots (store_id, run_id, source, payload) VALUES (?, ?, ?, ?)',
    [storeId, runId, source, JSON.stringify(payload)],
    db,
  );
}
