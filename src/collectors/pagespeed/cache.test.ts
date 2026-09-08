import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PagespeedRow } from '../../db/types.js';
import { ageMs, isFresh, MS_PER_DAY, staleStrategies } from './cache.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function row(strategy: 'mobile' | 'desktop', fetchedAt: string): PagespeedRow {
  return {
    id: 1,
    store_id: 1,
    strategy,
    performance: 40,
    accessibility: null,
    best_practices: null,
    seo: null,
    fcp_ms: null,
    lcp_ms: null,
    cls: null,
    inp_ms: null,
    ttfb_ms: null,
    speed_index_ms: null,
    raw_json: null,
    fetched_at: fetchedAt,
  };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

test('a result inside the TTL is fresh', () => {
  assert.equal(isFresh(row('mobile', daysAgo(6)), 7, NOW), true);
});

test('a result older than the TTL is stale', () => {
  assert.equal(isFresh(row('mobile', daysAgo(8)), 7, NOW), false);
});

test('the TTL boundary is exclusive — exactly N days old is stale', () => {
  assert.equal(isFresh(row('mobile', daysAgo(7)), 7, NOW), false);
  assert.equal(isFresh(row('mobile', daysAgo(6.999)), 7, NOW), true);
});

test('an unreadable timestamp counts as stale rather than as trusted', () => {
  assert.equal(ageMs(row('mobile', 'not a date'), NOW), null);
  assert.equal(isFresh(row('mobile', 'not a date'), 7, NOW), false);
});

test('a timestamp from the future is fresh, not negative-aged garbage', () => {
  assert.equal(isFresh(row('mobile', daysAgo(-1)), 7, NOW), true);
});

test('both strategies are stale when nothing is stored', () => {
  assert.deepEqual(staleStrategies([], 7, NOW), ['mobile', 'desktop']);
});

test('only the aged-out strategy is requested again', () => {
  const rows = [row('mobile', daysAgo(1)), row('desktop', daysAgo(30))];

  assert.deepEqual(staleStrategies(rows, 7, NOW), ['desktop']);
});

test('nothing is stale when both strategies are fresh', () => {
  const rows = [row('mobile', daysAgo(1)), row('desktop', daysAgo(2))];

  assert.deepEqual(staleStrategies(rows, 7, NOW), []);
});

test('a stored failure is still fresh — the point is to stop re-asking', () => {
  const failed = { ...row('mobile', daysAgo(1)), performance: null, raw_json: '{"error":"DNS"}' };

  assert.deepEqual(staleStrategies([failed, row('desktop', daysAgo(1))], 7, NOW), []);
});
