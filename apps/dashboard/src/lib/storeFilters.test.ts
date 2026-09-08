import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The filter contract of 6-03, pinned where it can be tested without a browser
 * or a database: the SQL lives in `queries.ts`, which imports `next/server` and
 * therefore cannot run here, so what is asserted is the shape both sides agree on.
 */
const FILTER_KEYS = [
  'domain',
  'rankMin',
  'rankMax',
  'scoreMin',
  'scoreMax',
  'revenueMin',
  'revenueMax',
  'issuesMin',
  'issuesMax',
  'status',
  'email',
  'category',
  'severity',
] as const;

test('every filter the UI writes is a filter the query reads', async () => {
  const queries = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./queries.ts', import.meta.url), 'utf-8'),
  );
  const component = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../components/store-filters.tsx', import.meta.url), 'utf-8'),
  );

  for (const key of FILTER_KEYS) {
    // A control that writes a parameter nothing reads silently does nothing,
    // and the page still renders, so nothing else would catch it.
    assert.ok(queries.includes(`filters.${key}`), `queries.ts never reads ${key}`);
    assert.ok(component.includes(`"${key}"`), `the reset list is missing ${key}`);
  }
});

test('the severity filter offers only severities the audit records', async () => {
  const component = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../components/store-filters.tsx', import.meta.url), 'utf-8'),
  );

  // MINOR is deliberately absent: "has at least one minor issue" matches almost
  // every shop and would filter nothing out.
  assert.match(component, /const SEVERITIES = \["CRITICAL", "MAJOR"\]/);
});
