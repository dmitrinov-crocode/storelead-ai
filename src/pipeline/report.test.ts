import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StepLogRow } from '../db/types.js';
import { formatRunReport, summariseRun, usageOf } from './report.js';

function log(overrides: Partial<StepLogRow> = {}): StepLogRow {
  return {
    id: 1,
    run_id: 7,
    store_id: 1,
    step: 'audit',
    status: 'OK',
    attempt: 1,
    started_at: '2026-09-08T10:00:00.000Z',
    finished_at: '2026-09-08T10:00:01.000Z',
    duration_ms: 1000,
    error: null,
    meta_json: null,
    ...overrides,
  };
}

test('counts are per step, in pipeline order', () => {
  const summary = summariseRun(7, [
    log({ id: 1, step: 'email_generation', store_id: 1 }),
    log({ id: 2, step: 'audit', store_id: 1 }),
    log({ id: 3, step: 'audit', store_id: 2, status: 'FAILED', error: 'boom' }),
    log({ id: 4, step: 'audit', store_id: 3, status: 'SKIPPED' }),
  ]);

  assert.deepEqual(
    summary.steps.map((step) => step.step),
    ['audit', 'email_generation'],
  );
  const audit = summary.steps[0]!;
  assert.deepEqual([audit.ok, audit.failed, audit.skipped], [1, 1, 1]);
  assert.deepEqual(audit.failedStores, [2]);
});

test('a retry that eventually succeeded is one success, not a failure and a success', () => {
  const summary = summariseRun(7, [
    log({ id: 1, store_id: 1, attempt: 1, status: 'FAILED', error: 'transient' }),
    log({ id: 2, store_id: 1, attempt: 2, status: 'OK' }),
  ]);

  // Counting both would make the retry ladder look like a failure rate.
  assert.deepEqual([summary.totals.ok, summary.totals.failed], [1, 0]);
  assert.deepEqual(summary.storesFailed, []);
});

test('a step still running is not counted either way', () => {
  const summary = summariseRun(7, [log({ status: 'RUNNING', duration_ms: null })]);
  assert.deepEqual(summary.steps, []);
});

test('the analysis step reports the tokens of both its agents', () => {
  const meta = JSON.stringify({
    usage: [
      { agent: 'store_analyst', tokensIn: 10802, tokensOut: 3753 },
      { agent: 'lead_classifier', tokensIn: 1270, tokensOut: 359 },
    ],
  });
  const summary = summariseRun(7, [log({ step: 'ai_analysis', meta_json: meta })]);

  assert.equal(summary.steps[0]?.tokensIn, 12072);
  assert.equal(summary.steps[0]?.tokensOut, 4112);
});

test('the outreach step reports the writer and the reviewer', () => {
  const meta = JSON.stringify({ tokensIn: 1000, tokensOut: 200, qcTokensIn: 700 });
  assert.deepEqual(usageOf(JSON.parse(meta)), { tokensIn: 1700, tokensOut: 200 });
});

test('the contact search reports what its web search spent', () => {
  assert.deepEqual(usageOf({ searchTokensIn: 8000, searchTokensOut: 900 }), {
    tokensIn: 8000,
    tokensOut: 900,
  });
});

test('a step whose meta says nothing about tokens contributes nothing', () => {
  // The totals are a floor, not a guess: what is counted was really spent.
  for (const meta of [null, undefined, 'text', 42, {}, { requests: 6 }, { tokensIn: 'many' }]) {
    assert.deepEqual(usageOf(meta), { tokensIn: 0, tokensOut: 0 });
  }
});

test('a store that failed anywhere is not counted as completed', () => {
  const summary = summariseRun(7, [
    log({ id: 1, step: 'audit', store_id: 1 }),
    log({ id: 2, step: 'pagespeed', store_id: 1, status: 'FAILED', error: 'timed out' }),
    log({ id: 3, step: 'audit', store_id: 2 }),
  ]);

  assert.deepEqual(summary.storesCompleted, [2]);
  assert.deepEqual(summary.storesFailed, [1]);
});

test('the same error many times is one line with a count', () => {
  const summary = summariseRun(7, [
    log({ id: 1, step: 'pagespeed', store_id: 1, status: 'FAILED', error: 'timed out' }),
    log({ id: 2, step: 'pagespeed', store_id: 2, status: 'FAILED', error: 'timed out' }),
    log({ id: 3, step: 'pagespeed', store_id: 3, status: 'FAILED', error: 'quota' }),
  ]);

  assert.deepEqual(summary.steps[0]?.errors, [
    { message: 'timed out', count: 2 },
    { message: 'quota', count: 1 },
  ]);
});

test('a run-scoped step has no store and does not distort the store counts', () => {
  const summary = summariseRun(7, [
    log({ id: 1, step: 'fetch_stores', store_id: null }),
    log({ id: 2, step: 'audit', store_id: 1 }),
  ]);

  assert.deepEqual(summary.storesCompleted, [1]);
  assert.equal(summary.totals.ok, 2);
});

test('the printed report names the totals and where it went wrong', () => {
  const text = formatRunReport(
    summariseRun(7, [
      log({ id: 1, step: 'audit', store_id: 1 }),
      log({
        id: 2,
        step: 'pagespeed',
        store_id: 42,
        status: 'FAILED',
        error: 'timed out after 600000ms',
        duration_ms: 600000,
      }),
      log({
        id: 3,
        step: 'ai_analysis',
        store_id: 1,
        meta_json: JSON.stringify({ usage: [{ tokensIn: 1200, tokensOut: 300 }] }),
      }),
    ]),
  );

  assert.match(text, /Run #7/);
  assert.match(text, /pagespeed\s+0\s+1/);
  assert.match(text, /600\.0s/);
  assert.match(text, /1,200/);
  assert.match(text, /where it went wrong:/);
  assert.match(text, /timed out after 600000ms/);
  assert.match(text, /stores 42/);
});

test('a run with nothing wrong prints no failure section', () => {
  const text = formatRunReport(summariseRun(7, [log()]));
  assert.doesNotMatch(text, /where it went wrong/);
  assert.match(text, /stores through every step: 1/);
});
