import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { parseScreenshotId, resolveScreenshot } from './screenshots.js';

const ROOT = '/var/storelead/screenshots';

test('a stored path resolves inside the screenshots directory', () => {
  assert.equal(
    resolveScreenshot(ROOT, 'sklep.pl/audit-11/homepage-desktop.png'),
    path.join(ROOT, 'sklep.pl/audit-11/homepage-desktop.png'),
  );
});

test('a row pointing outside the directory resolves to nothing', () => {
  // The path comes from the database, and a stored path is still data that
  // something else wrote.
  for (const escape of [
    '../../.env',
    '../../../etc/passwd',
    '/etc/passwd',
    'sklep.pl/../../../.env',
  ]) {
    assert.equal(resolveScreenshot(ROOT, escape), null, escape);
  }
});

test('a sibling directory with the same prefix is not inside', () => {
  // `startsWith` on the bare prefix would accept this.
  assert.equal(resolveScreenshot(ROOT, '../screenshots-evil/x.png'), null);
});

test('a path that normalises back inside is allowed', () => {
  assert.equal(
    resolveScreenshot(ROOT, 'sklep.pl/../inny.pl/home.png'),
    path.join(ROOT, 'inny.pl/home.png'),
  );
});

test('empty inputs resolve to nothing rather than to the root', () => {
  assert.equal(resolveScreenshot(ROOT, ''), null);
  assert.equal(resolveScreenshot(ROOT, '   '), null);
  assert.equal(resolveScreenshot('', 'a.png'), null);
});

test('only a positive whole number is a screenshot id', () => {
  assert.equal(parseScreenshotId('24'), 24);
  // `Number()` would take the last four of these.
  for (const bad of ['0', '-1', 'abc', '', '1.5', '../../../etc/passwd', '1e3', '0x10', '+5', ' 5 ']) {
    assert.equal(parseScreenshotId(bad), null, bad);
  }
});
