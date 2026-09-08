import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildOrderBy,
  DEFAULT_DIRECTION,
  DEFAULT_SORT,
  isSortKey,
  nextDirection,
  parseDirection,
  parseSort,
  SORT_COLUMNS,
} from './sorting.js';

test('every sortable column has a label and an expression', () => {
  for (const [key, column] of Object.entries(SORT_COLUMNS)) {
    assert.ok(column.expression.length > 0, `${key} has no expression`);
    assert.ok(column.label.length > 0, `${key} has no label`);
    assert.ok(['asc', 'desc'].includes(column.defaultDirection));
  }
});

test('the default sort is a real column', () => {
  assert.ok(isSortKey(DEFAULT_SORT));
  assert.ok(['asc', 'desc'].includes(DEFAULT_DIRECTION));
});

test('an unknown sort key falls back to the default instead of erroring', () => {
  // "__proto__" and "constructor" must not slip through: `key in obj` would
  // accept them and yield an expression of `undefined`.
  for (const bad of [
    undefined,
    '',
    'nope',
    'DROP TABLE stores',
    '1',
    '__proto__',
    'constructor',
    'toString',
  ]) {
    assert.equal(parseSort(bad), DEFAULT_SORT, `parseSort(${String(bad)})`);
  }
});

test('a known sort key is accepted, first value wins for repeats', () => {
  assert.equal(parseSort('rank'), 'rank');
  assert.equal(parseSort(['domain', 'rank']), 'domain');
});

test('direction parsing only accepts asc and desc', () => {
  assert.equal(parseDirection('asc', 'desc'), 'asc');
  assert.equal(parseDirection('desc', 'asc'), 'desc');
  assert.equal(parseDirection('sideways', 'asc'), 'asc');
  assert.equal(parseDirection(undefined, 'desc'), 'desc');
  assert.equal(parseDirection('ASC', 'desc'), 'desc', 'casing is not guessed at');
});

test('no sort expression can carry injected SQL', () => {
  // The key selects an expression; it is never concatenated into the query.
  const clause = buildOrderBy(parseSort("rank; DROP TABLE stores --"), 'asc');
  assert.doesNotMatch(clause, /DROP/i);
  assert.doesNotMatch(clause, /;/);
});

test('order by puts missing values last in both directions', () => {
  const asc = buildOrderBy('rank', 'asc');
  const desc = buildOrderBy('rank', 'desc');
  assert.match(asc, /s\.rank IS NULL, s\.rank ASC/);
  assert.match(desc, /s\.rank IS NULL, s\.rank DESC/);
  assert.ok(asc.startsWith('s.rank IS NULL'), 'nulls last comes first in the clause');
});

test('order by always ends with a stable tiebreaker', () => {
  for (const key of Object.keys(SORT_COLUMNS) as (keyof typeof SORT_COLUMNS)[]) {
    for (const dir of ['asc', 'desc'] as const) {
      assert.match(
        buildOrderBy(key, dir),
        /s\.id ASC$/,
        `${key}/${dir} needs a tiebreaker or paging repeats rows`,
      );
    }
  }
});

test('critical issues outrank major ones', () => {
  const clause = buildOrderBy('issues', 'desc');
  assert.match(clause, /critical_issues, 0\) \* 1000/);
});

test('clicking a new column uses that column preferred direction', () => {
  assert.equal(nextDirection('rank', 'score', 'desc'), 'asc', 'rank reads best ascending');
  assert.equal(nextDirection('score', 'rank', 'asc'), 'desc', 'score reads best descending');
  assert.equal(nextDirection('domain', 'rank', 'desc'), 'asc');
});

test('clicking the active column flips the direction', () => {
  assert.equal(nextDirection('rank', 'rank', 'asc'), 'desc');
  assert.equal(nextDirection('rank', 'rank', 'desc'), 'asc');
});
