import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createMemoryDb, type Database } from '../../db/client.js';
import { migrate } from '../../db/migrate.js';
import { createRun } from '../../db/repositories/runs.js';
import { upsertStore } from '../../db/repositories/stores.js';
import {
  getPagespeedResult,
  listPagespeedResults,
  savePagespeedResult,
} from '../../db/repositories/storeFacts.js';
import { PagespeedError } from '../../collectors/pagespeed/client.js';
import type { PagespeedRunResult } from '../../collectors/pagespeed/client.js';
import { extractMetrics } from '../../collectors/pagespeed/metrics.js';
import { PagespeedQuota } from '../../collectors/pagespeed/quota.js';
import type { PagespeedResponse, PagespeedStrategy } from '../../collectors/pagespeed/types.js';
import { silentLogger } from '../../lib/logger.js';
import type { StoreRow } from '../../db/types.js';
import { createPagespeedStep, type PagespeedSource, type PagespeedStepMeta } from './pagespeed.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'db', 'migrations');
const FIXTURES = path.join(import.meta.dirname, '..', '..', 'collectors', 'pagespeed', 'fixtures');

const NOW = new Date('2026-09-01T12:00:00.000Z');

function fixture(name: string): PagespeedResponse {
  return JSON.parse(
    readFileSync(path.join(FIXTURES, `${name}.json`), 'utf-8'),
  ) as PagespeedResponse;
}

const RUN_OK = fixture('run-mobile');
const RUN_FAILED = fixture('run-failed');

function freshDb(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  return db;
}

function setup(): { db: Database; runId: number; store: StoreRow } {
  const db = freshDb();
  const runId = createRun('PL', 10, db).id;
  const { store } = upsertStore({ domain: 'sklep.pl', url: 'https://sklep.pl' }, db);
  return { db, runId, store };
}

/** Answers with a scripted response (or error) per call, recording every request. */
function stubSource(script: (PagespeedResponse | Error)[]) {
  const calls: { url: string; strategy: PagespeedStrategy }[] = [];
  let index = 0;
  const source: PagespeedSource = {
    run: (url, strategy) => {
      calls.push({ url, strategy });
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next instanceof Error) return Promise.reject(next);
      const response = next ?? RUN_OK;
      return Promise.resolve({
        metrics: extractMetrics(response, strategy),
        raw: response,
      } satisfies PagespeedRunResult);
    },
  };
  return { source, calls };
}

function context(
  db: Database,
  runId: number,
  store: StoreRow | null,
  force = false,
  signal = new AbortController().signal,
) {
  return { runId, store, db, logger: silentLogger(), force, signal };
}

function makeStep(
  source: PagespeedSource,
  overrides: Parameters<typeof createPagespeedStep>[0] = {},
) {
  return createPagespeedStep({
    client: source,
    cacheDays: 7,
    maxRequestsPerRun: 100,
    now: () => NOW,
    ...overrides,
  });
}

test('measures both strategies and stores a row for each', async () => {
  const { db, runId, store } = setup();
  const { source, calls } = stubSource([RUN_OK]);

  const outcome = await makeStep(source).run(context(db, runId, store));

  assert.equal(outcome.status, 'OK');
  assert.deepEqual(
    calls.map((c) => c.strategy),
    ['mobile', 'desktop'],
  );
  assert.equal(calls[0]!.url, 'https://sklep.pl');

  const rows = listPagespeedResults(store.id, db);
  assert.equal(rows.length, 2);
  assert.equal(getPagespeedResult(store.id, 'mobile', db)!.performance, 70);
  assert.equal(getPagespeedResult(store.id, 'mobile', db)!.lcp_ms, 5476);
  assert.deepEqual((outcome.meta as PagespeedStepMeta).fetched, ['mobile', 'desktop']);
});

test('keeps the raw response for later re-analysis', async () => {
  const { db, runId, store } = setup();
  const { source } = stubSource([RUN_OK]);

  await makeStep(source).run(context(db, runId, store));

  const raw = JSON.parse(
    getPagespeedResult(store.id, 'mobile', db)!.raw_json!,
  ) as PagespeedResponse;
  assert.equal(raw.lighthouseResult?.lighthouseVersion, '13.4.1');
});

test('is unsatisfied until both strategies are stored, then satisfied', async () => {
  const { db, runId, store } = setup();
  const { source } = stubSource([RUN_OK]);
  const step = makeStep(source);

  assert.equal(step.isSatisfied!(context(db, runId, store)), false);
  await step.run(context(db, runId, store));
  assert.equal(step.isSatisfied!(context(db, runId, store)), true);
});

test('a result inside the TTL is not requested again', async () => {
  const { db, runId, store } = setup();
  savePagespeedResult(
    store.id,
    { strategy: 'mobile', performance: 40, fetchedAt: '2026-08-30T12:00:00.000Z' },
    db,
  );
  savePagespeedResult(
    store.id,
    { strategy: 'desktop', performance: 70, fetchedAt: '2026-08-30T12:00:00.000Z' },
    db,
  );
  const { source, calls } = stubSource([RUN_OK]);

  const outcome = await makeStep(source).run(context(db, runId, store));

  assert.equal(calls.length, 0);
  assert.equal(outcome.status, 'SKIPPED');
  assert.deepEqual((outcome.meta as PagespeedStepMeta).cached, ['mobile', 'desktop']);
  // The stored numbers are untouched.
  assert.equal(getPagespeedResult(store.id, 'mobile', db)!.performance, 40);
});

test('only the aged-out strategy is re-measured', async () => {
  const { db, runId, store } = setup();
  savePagespeedResult(
    store.id,
    { strategy: 'mobile', performance: 40, fetchedAt: '2026-08-31T12:00:00.000Z' },
    db,
  );
  savePagespeedResult(
    store.id,
    { strategy: 'desktop', performance: 70, fetchedAt: '2026-07-01T12:00:00.000Z' },
    db,
  );
  const { source, calls } = stubSource([RUN_OK]);

  const outcome = await makeStep(source).run(context(db, runId, store));

  assert.deepEqual(
    calls.map((c) => c.strategy),
    ['desktop'],
  );
  assert.deepEqual((outcome.meta as PagespeedStepMeta).cached, ['mobile']);
  assert.equal(getPagespeedResult(store.id, 'mobile', db)!.performance, 40);
});

test('--force re-measures both strategies despite a fresh cache', async () => {
  const { db, runId, store } = setup();
  savePagespeedResult(
    store.id,
    { strategy: 'mobile', performance: 40, fetchedAt: '2026-09-01T11:00:00.000Z' },
    db,
  );
  savePagespeedResult(
    store.id,
    { strategy: 'desktop', performance: 70, fetchedAt: '2026-09-01T11:00:00.000Z' },
    db,
  );
  const { source, calls } = stubSource([RUN_OK]);

  await makeStep(source).run(context(db, runId, store, true));

  assert.equal(calls.length, 2);
  assert.equal(getPagespeedResult(store.id, 'mobile', db)!.performance, 70);
});

test('a 200 that carries a runtimeError is stored as a failure, not as zeros', async () => {
  const { db, runId, store } = setup();
  const { source } = stubSource([RUN_FAILED]);

  const outcome = await makeStep(source).run(context(db, runId, store));

  const row = getPagespeedResult(store.id, 'mobile', db)!;
  assert.equal(row.performance, null);
  assert.equal(row.fcp_ms, null);
  const meta = outcome.meta as PagespeedStepMeta;
  assert.deepEqual(meta.fetched, []);
  assert.deepEqual(
    meta.unanalysable.map((u) => u.code),
    ['ERRORED_DOCUMENT_REQUEST', 'ERRORED_DOCUMENT_REQUEST'],
  );
  // There are no scores, but "this store does not load" is a fact we now hold
  // and cached — that is work done, not a skip.
  assert.equal(outcome.status, 'OK');
});

test('a store the API refuses to analyse is cached as such, so it is not asked again', async () => {
  const { db, runId, store } = setup();
  const { source, calls } = stubSource([
    new PagespeedError('PageSpeed could not analyse the page (500)', {
      status: 500,
      retryable: false,
      lighthouseErrorCode: 'DNS_FAILURE',
    }),
  ]);
  const step = makeStep(source);

  const outcome = await step.run(context(db, runId, store));

  assert.equal(calls.length, 2);
  assert.match(getPagespeedResult(store.id, 'mobile', db)!.raw_json!, /DNS_FAILURE/);
  assert.deepEqual(
    (outcome.meta as PagespeedStepMeta).unanalysable.map((u) => u.code),
    ['DNS_FAILURE', 'DNS_FAILURE'],
  );
  // The cached failure is what stops the next run from spending quota here.
  assert.equal(step.isSatisfied!(context(db, runId, store)), true);
});

test('the first quota error stops every later request in the run', async () => {
  const { db, runId, store } = setup();
  const second = upsertStore({ domain: 'inny.pl', url: 'https://inny.pl' }, db).store;
  const { source, calls } = stubSource([
    new PagespeedError('PageSpeed quota exceeded (429)', {
      status: 429,
      retryable: true,
      quotaExceeded: true,
    }),
  ]);
  const step = makeStep(source);

  const first = await step.run(context(db, runId, store));
  const next = await step.run(context(db, runId, second));

  // One call for the first store's mobile; desktop and the whole second store are skipped.
  assert.equal(calls.length, 1);
  assert.equal(first.status, 'SKIPPED');
  assert.equal(next.status, 'SKIPPED');
  assert.match((next.meta as PagespeedStepMeta).skipped[0]!.reason, /quota exhausted/);
  assert.equal(listPagespeedResults(store.id, db).length, 0);
});

test('the per-run budget caps how much one run can spend', async () => {
  const { db, runId, store } = setup();
  const second = upsertStore({ domain: 'inny.pl', url: 'https://inny.pl' }, db).store;
  const { source, calls } = stubSource([RUN_OK]);
  const step = makeStep(source, { quota: new PagespeedQuota({ maxRequests: 3 }) });

  await step.run(context(db, runId, store));
  const outcome = await step.run(context(db, runId, second));

  assert.equal(calls.length, 3);
  const meta = outcome.meta as PagespeedStepMeta;
  assert.deepEqual(meta.fetched, ['mobile']);
  assert.deepEqual(
    meta.skipped.map((s) => s.strategy),
    ['desktop'],
  );
  assert.match(meta.skipped[0]!.reason, /budget spent/);
});

test('a transport failure is raised, not cached as a broken store', async () => {
  const { db, runId, store } = setup();
  const { source } = stubSource([
    new PagespeedError('PageSpeed server error (503)', { status: 503, retryable: true }),
  ]);

  await assert.rejects(makeStep(source).run(context(db, runId, store)), /server error \(503\)/);
  assert.equal(listPagespeedResults(store.id, db).length, 0);
});

test('refuses to run without a store', async () => {
  const { db, runId } = setup();
  const { source } = stubSource([RUN_OK]);

  await assert.rejects(makeStep(source).run(context(db, runId, null)), /store-scoped/);
});

test('skips rather than failing the store when no API key is configured', async () => {
  const { db, runId, store } = setup();

  // No client and no key: nothing to ask with. Marking the store FAILED here
  // would blame it for a line missing from .env.
  const step = createPagespeedStep({
    apiKey: undefined,
    cacheDays: 7,
    maxRequestsPerRun: 100,
    now: () => NOW,
  });
  const outcome = await step.run(context(db, runId, store));

  assert.equal(outcome.status, 'SKIPPED');
  assert.deepEqual(
    (outcome.meta as PagespeedStepMeta).skipped.map((s) => s.reason),
    ['PAGESPEED_API_KEY is not set', 'PAGESPEED_API_KEY is not set'],
  );
  assert.equal(listPagespeedResults(store.id, db).length, 0);
});

test('keeps what it measured when the step budget runs out mid-way', async () => {
  const { db, runId, store } = setup();
  const controller = new AbortController();
  // Abort as soon as the first strategy has been served.
  const { source } = stubSource([RUN_OK]);
  const aborting: PagespeedSource = {
    run: async (url, strategy) => {
      const result = await source.run(url, strategy);
      controller.abort();
      return result;
    },
  };

  const outcome = await makeStep(aborting).run(context(db, runId, store, false, controller.signal));

  // Mobile was measured and saved; desktop is reported as skipped, not lost.
  assert.equal(outcome.status, 'OK');
  assert.deepEqual((outcome.meta as PagespeedStepMeta).fetched, ['mobile']);
  assert.deepEqual(
    (outcome.meta as PagespeedStepMeta).skipped.map((s) => s.reason),
    ['step timed out before this strategy'],
  );
  assert.equal(listPagespeedResults(store.id, db).length, 1);
});
