import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMAIL_STATUS_META,
  legendEntries,
  RUN_STATUS_META,
  SEVERITY_META,
  statusMeta,
  STORE_STATUS_META,
} from './status-meta.js';
import { EMAIL_STATUSES, RUN_STATUSES, STORE_STATUSES } from '../../../../src/pipeline/status.js';

test('every store status the pipeline can set has presentation', () => {
  for (const status of STORE_STATUSES) {
    assert.ok(status in STORE_STATUS_META, `missing meta for store status ${status}`);
  }
  assert.equal(Object.keys(STORE_STATUS_META).length, STORE_STATUSES.length, 'no extra entries');
});

test('every run status has presentation', () => {
  for (const status of RUN_STATUSES) {
    assert.ok(status in RUN_STATUS_META, `missing meta for run status ${status}`);
  }
  assert.equal(Object.keys(RUN_STATUS_META).length, RUN_STATUSES.length);
});

test('every email status has presentation', () => {
  for (const status of EMAIL_STATUSES) {
    assert.ok(status in EMAIL_STATUS_META, `missing meta for email status ${status}`);
  }
  assert.equal(Object.keys(EMAIL_STATUS_META).length, EMAIL_STATUSES.length);
});

test('descriptions are short enough to sit on one legend line', () => {
  const all = [STORE_STATUS_META, RUN_STATUS_META, EMAIL_STATUS_META, SEVERITY_META];
  for (const table of all) {
    for (const [status, meta] of Object.entries(table)) {
      assert.ok(meta.description.length > 0, `${status} has no description`);
      assert.ok(meta.description.length <= 60, `${status} description is too long`);
    }
  }
});

test('failure and success never share a colour', () => {
  assert.notEqual(STORE_STATUS_META.FAILED.className, STORE_STATUS_META.APPROVED.className);
  assert.notEqual(RUN_STATUS_META.FAILED.className, RUN_STATUS_META.COMPLETED.className);
  assert.match(RUN_STATUS_META.FAILED.className, /red/);
  assert.match(RUN_STATUS_META.COMPLETED.className, /emerald/);
});

test('every colour is defined for both themes', () => {
  const all = [STORE_STATUS_META, RUN_STATUS_META, EMAIL_STATUS_META, SEVERITY_META];
  for (const table of all) {
    for (const [status, meta] of Object.entries(table)) {
      assert.match(meta.className, /\bbg-/, `${status} has no background`);
      assert.match(meta.className, /\bdark:text-/, `${status} has no dark-mode text colour`);
    }
  }
});

test('statuses that need attention are visually distinct from finished ones', () => {
  assert.match(STORE_STATUS_META.EMAIL_READY.className, /amber/);
  assert.match(EMAIL_STATUS_META.READY.className, /amber/);
  assert.match(SEVERITY_META.CRITICAL.className, /red/);
  assert.match(SEVERITY_META.MAJOR.className, /amber/);
});

test('an unknown or missing status still renders instead of crashing', () => {
  assert.equal(statusMeta(STORE_STATUS_META, 'WAT').description, 'Unknown status');
  assert.equal(statusMeta(STORE_STATUS_META, null).description, 'Unknown status');
  assert.equal(statusMeta(STORE_STATUS_META, undefined).description, 'Unknown status');
  assert.ok(statusMeta(STORE_STATUS_META, 'WAT').className.length > 0);
});

test('a known status resolves to its own metadata', () => {
  assert.equal(statusMeta(STORE_STATUS_META, 'NEW'), STORE_STATUS_META.NEW);
  assert.equal(statusMeta(RUN_STATUS_META, 'RUNNING'), RUN_STATUS_META.RUNNING);
});

test('legend lists statuses in pipeline order, not alphabetically', () => {
  const order = legendEntries(STORE_STATUS_META).map((e) => e.status);
  assert.deepEqual(order.slice(0, 5), [
    'NEW',
    'AUDITED',
    'ANALYZED',
    'CONTACTED',
    'EMAIL_READY',
  ]);
  assert.deepEqual(order, [...STORE_STATUSES], 'matches the state machine order');
});
