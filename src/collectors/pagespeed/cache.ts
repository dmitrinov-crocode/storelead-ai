import type { PagespeedRow } from '../../db/types.js';
import { STRATEGIES } from './types.js';
import type { PagespeedStrategy } from './types.js';

/**
 * Freshness rules for stored PageSpeed results (task 2-20).
 *
 * A run is expensive on Google's side and on our quota, while the numbers move
 * slowly — a store that was slow last Tuesday is slow today. So a stored row is
 * reused until it is older than the TTL, and `fetched_at` is the only thing that
 * decides. A row whose analysis failed still counts as fresh: re-asking about a
 * store that does not load, once per run, would spend the whole quota on stores
 * we already know are broken.
 */

export const MS_PER_DAY = 86_400_000;

export function ageMs(
  row: Pick<PagespeedRow, 'fetched_at'>,
  now: Date = new Date(),
): number | null {
  const fetched = Date.parse(row.fetched_at);
  if (!Number.isFinite(fetched)) return null;
  return now.getTime() - fetched;
}

/** A row with an unreadable timestamp is treated as stale — better to refetch than to trust it. */
export function isFresh(
  row: Pick<PagespeedRow, 'fetched_at'>,
  ttlDays: number,
  now: Date = new Date(),
): boolean {
  const age = ageMs(row, now);
  if (age === null) return false;
  // A negative age means the clock moved backwards; the row is newer than now,
  // which is as fresh as it gets.
  return age < ttlDays * MS_PER_DAY;
}

/** The strategies still worth requesting for a store, in a stable order. */
export function staleStrategies(
  rows: readonly PagespeedRow[],
  ttlDays: number,
  now: Date = new Date(),
): PagespeedStrategy[] {
  return STRATEGIES.filter((strategy) => {
    const row = rows.find((r) => r.strategy === strategy);
    return !row || !isFresh(row, ttlDays, now);
  });
}
