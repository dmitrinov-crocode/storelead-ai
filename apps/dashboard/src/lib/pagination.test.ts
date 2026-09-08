import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  pageHref,
  paginate,
  parsePage,
  parsePageSize,
} from './pagination.js';

test('splits a total into pages and reports the visible range', () => {
  const info = paginate(137, 2, 20);
  assert.equal(info.totalPages, 7);
  assert.equal(info.offset, 20);
  assert.equal(info.from, 21);
  assert.equal(info.to, 40);
  assert.equal(info.hasPrev, true);
  assert.equal(info.hasNext, true);
});

test('the last page is short and has no next', () => {
  const info = paginate(137, 7, 20);
  assert.equal(info.from, 121);
  assert.equal(info.to, 137, 'does not run past the total');
  assert.equal(info.hasNext, false);
  assert.equal(info.hasPrev, true);
});

test('an exact multiple does not create a trailing empty page', () => {
  assert.equal(paginate(40, 1, 20).totalPages, 2);
  assert.equal(paginate(40, 2, 20).hasNext, false);
});

test('an empty table still has one page and an empty range', () => {
  const info = paginate(0, 1, 20);
  assert.equal(info.totalPages, 1, 'never shows "page 1 of 0"');
  assert.equal(info.from, 0);
  assert.equal(info.to, 0);
  assert.equal(info.hasPrev, false);
  assert.equal(info.hasNext, false);
});

test('a page beyond the end clamps to the last page', () => {
  const info = paginate(25, 999, 20);
  assert.equal(info.page, 2, 'a stale bookmark shows the last page, not an error');
  assert.equal(info.offset, 20);
});

test('a page below one clamps to the first', () => {
  assert.equal(paginate(25, 0, 20).page, 1);
  assert.equal(paginate(25, -5, 20).page, 1);
});

test('nonsense totals and sizes cannot produce a broken query', () => {
  const info = paginate(-10, 1, 0);
  assert.equal(info.total, 0);
  assert.ok(info.pageSize >= 1);
  assert.ok(info.offset >= 0);
  assert.equal(paginate(10, 1, 99999).pageSize, MAX_PAGE_SIZE);
});

test('parsePage tolerates anything a URL can carry', () => {
  assert.equal(parsePage('3'), 3);
  assert.equal(parsePage(['4', '9']), 4, 'repeated params take the first');
  for (const bad of [undefined, '', 'abc', '0', '-2', 'NaN', '2.7abc']) {
    const result = parsePage(bad);
    assert.ok(result >= 1, `parsePage(${String(bad)}) should be >= 1, got ${result}`);
  }
  assert.equal(parsePage('abc'), 1);
});

test('parsePageSize falls back to the default and caps the maximum', () => {
  assert.equal(parsePageSize('50'), 50);
  assert.equal(parsePageSize(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(parsePageSize('0'), DEFAULT_PAGE_SIZE);
  assert.equal(parsePageSize('abc'), DEFAULT_PAGE_SIZE);
  assert.equal(parsePageSize('100000'), MAX_PAGE_SIZE);
});

test('pageHref keeps the other table on its own page', () => {
  const href = pageHref({ storesPage: '3', runsPage: '2' }, 'storesPage', 4);
  const params = new URL(href, 'http://x').searchParams;
  assert.equal(params.get('storesPage'), '4');
  assert.equal(params.get('runsPage'), '2', 'paging one table must not reset the other');
});

test('pageHref drops the parameter for page one so the base URL stays clean', () => {
  assert.equal(pageHref({ storesPage: '2' }, 'storesPage', 1), '/');
  assert.equal(pageHref({}, 'storesPage', 1), '/');
  assert.equal(pageHref({ runsPage: '3' }, 'storesPage', 1), '/?runsPage=3');
});

test('pageHref does not carry empty values into the query', () => {
  const href = pageHref({ runsPage: undefined, storesPage: '1' }, 'storesPage', 2);
  assert.equal(href, '/?storesPage=2');
});
