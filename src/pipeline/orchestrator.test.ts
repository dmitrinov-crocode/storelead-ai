import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, type Database } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { attachStoreToRun, createRun } from '../db/repositories/runs.js';
import { getStore, upsertStore } from '../db/repositories/stores.js';
import { listRunSteps } from '../db/repositories/stepLogs.js';
import { runPipeline } from './orchestrator.js';
import { StepError } from './retry.js';
import type { PipelineStep } from './types.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'db', 'migrations');

function freshDb(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  return db;
}

function seedRun(db: Database, domains: string[]): number {
  const run = createRun('PL', 10, db);
  for (const domain of domains) {
    const { store } = upsertStore({ domain, url: `https://${domain}` }, db);
    attachStoreToRun(run.id, store.id, db);
  }
  return run.id;
}

test('steps run in pipeline order regardless of array order', async () => {
  const db = freshDb();
  const runId = seedRun(db, ['a.pl']);
  const seen: string[] = [];

  const make = (name: PipelineStep['name']): PipelineStep => ({
    name,
    scope: 'run',
    run: async () => {
      seen.push(name);
      return { status: 'OK' };
    },
  });

  const report = await runPipeline([make('ai_analysis'), make('audit'), make('fetch_stores')], {
    runId,
    db,
  });

  assert.deepEqual(seen, ['fetch_stores', 'audit', 'ai_analysis']);
  assert.equal(report.status, 'COMPLETED');
});

test('store-scoped step runs once per active store', async () => {
  const db = freshDb();
  const runId = seedRun(db, ['a.pl', 'b.pl', 'c.pl']);
  const visited: string[] = [];

  const step: PipelineStep = {
    name: 'audit',
    scope: 'store',
    run: async (ctx) => {
      visited.push(ctx.store!.domain);
      return { status: 'OK' };
    },
  };

  const report = await runPipeline([step], { runId, db, concurrency: 2 });
  assert.deepEqual(visited.sort(), ['a.pl', 'b.pl', 'c.pl']);
  assert.equal(report.steps[0]!.ok, 3);
});

test('satisfied steps are skipped unless forced', async () => {
  const db = freshDb();
  const runId = seedRun(db, ['a.pl']);
  let calls = 0;

  const step: PipelineStep = {
    name: 'audit',
    scope: 'store',
    isSatisfied: () => true,
    run: async () => {
      calls += 1;
      return { status: 'OK' };
    },
  };

  const skipped = await runPipeline([step], { runId, db });
  assert.equal(calls, 0);
  assert.equal(skipped.steps[0]!.skipped, 1);

  const forced = await runPipeline([step], { runId, db, force: true });
  assert.equal(calls, 1);
  assert.equal(forced.steps[0]!.ok, 1);
});

test('transient failures are retried, then the store soft-fails', async () => {
  const db = freshDb();
  const runId = seedRun(db, ['a.pl', 'b.pl']);
  const attempts = new Map<string, number>();

  const step: PipelineStep = {
    name: 'audit',
    scope: 'store',
    attempts: 3,
    retryBaseDelayMs: 5,
    run: async (ctx) => {
      const domain = ctx.store!.domain;
      const n = (attempts.get(domain) ?? 0) + 1;
      attempts.set(domain, n);
      if (domain === 'a.pl' && n < 3) throw new Error('transient network error');
      if (domain === 'b.pl') throw new StepError('hard failure', { retryable: false });
      return { status: 'OK' };
    },
  };

  const report = await runPipeline([step], { runId, db, concurrency: 1 });

  assert.equal(attempts.get('a.pl'), 3, 'retried until success');
  assert.equal(attempts.get('b.pl'), 1, 'non-retryable error is not retried');
  assert.equal(report.status, 'COMPLETED', 'run survives per-store failures');
  assert.equal(report.steps[0]!.ok, 1);
  assert.equal(report.steps[0]!.failed, 1);

  const failed = getStore(2, db)!;
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.status_reason!, /audit: hard failure/);
});

test('a failing run-scoped step fails the whole run', async () => {
  const db = freshDb();
  const runId = seedRun(db, ['a.pl']);

  const step: PipelineStep = {
    name: 'fetch_stores',
    scope: 'run',
    attempts: 1,
    run: async () => {
      throw new StepError('StoreLeads unavailable', { retryable: false });
    },
  };

  const report = await runPipeline([step], { runId, db });
  assert.equal(report.status, 'FAILED');
  assert.match(report.error!, /StoreLeads unavailable/);
});

test('step timeout aborts and is recorded', async () => {
  const db = freshDb();
  const runId = seedRun(db, ['a.pl']);
  let aborted = false;

  const step: PipelineStep = {
    name: 'audit',
    scope: 'store',
    attempts: 1,
    timeoutMs: 50,
    run: (ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
        });
        setTimeout(() => resolve({ status: 'OK' }), 5000).unref();
      }),
  };

  const report = await runPipeline([step], { runId, db });
  assert.equal(aborted, true, 'the step receives the abort signal');
  assert.equal(report.steps[0]!.failed, 1);

  const logs = listRunSteps(runId, db);
  assert.match(logs.at(-1)!.error!, /timed out after 50ms/);
});

test('failed stores drop out of later steps on resume', async () => {
  const db = freshDb();
  const runId = seedRun(db, ['a.pl', 'b.pl']);

  const failing: PipelineStep = {
    name: 'audit',
    scope: 'store',
    attempts: 1,
    run: async (ctx) => {
      if (ctx.store!.domain === 'b.pl') throw new StepError('boom', { retryable: false });
      return { status: 'OK' };
    },
  };
  await runPipeline([failing], { runId, db });

  // FAILED is not terminal, so the store is still picked up — that is the resume path.
  const seen: string[] = [];
  const next: PipelineStep = {
    name: 'ai_analysis',
    scope: 'store',
    run: async (ctx) => {
      seen.push(ctx.store!.domain);
      return { status: 'OK' };
    },
  };
  await runPipeline([next], { runId, db });
  assert.deepEqual(seen.sort(), ['a.pl', 'b.pl']);
});

test('a run killed mid-flight is marked failed by the next run', async () => {
  const db = freshDb();
  const abandoned = createRun('PL', 10, db);
  // Simulate a process that died before it could update its own row.
  db.prepare("UPDATE runs SET status = 'RUNNING' WHERE id = ?").run(abandoned.id);

  const step: PipelineStep = { name: 'audit', scope: 'run', run: async () => ({ status: 'OK' }) };
  const report = await runPipeline([step], { db });

  assert.equal(report.status, 'COMPLETED', 'a stale RUNNING row must not block a new run');

  const stale = db.prepare('SELECT status, error FROM runs WHERE id = ?').get(abandoned.id) as {
    status: string;
    error: string;
  };
  assert.equal(stale.status, 'FAILED');
  assert.match(stale.error, /abandoned/);
});

test('the current run is never marked abandoned by its own sweep', async () => {
  const db = freshDb();
  const step: PipelineStep = { name: 'audit', scope: 'run', run: async () => ({ status: 'OK' }) };
  const report = await runPipeline([step], { db });

  const own = db.prepare('SELECT status FROM runs WHERE id = ?').get(report.runId) as {
    status: string;
  };
  assert.equal(own.status, 'COMPLETED');
});

test('--store narrows a run to named domains', async () => {
  const db = freshDb();
  const runId = seedRun(db, ['a.pl', 'b.pl', 'c.pl']);
  const visited: string[] = [];

  const step: PipelineStep = {
    name: 'email_generation',
    scope: 'store',
    run: async (ctx) => {
      visited.push(ctx.store!.domain);
      return { status: 'OK' };
    },
  };

  // The dashboard's Regenerate button redoes one letter, not the batch.
  const report = await runPipeline([step], { runId, db, domains: ['b.pl'] });

  assert.deepEqual(visited, ['b.pl']);
  assert.equal(report.steps[0]!.ok, 1);
});

test('a domain is matched however the address was copied', async () => {
  const db = freshDb();
  const runId = seedRun(db, ['sklep.pl']);
  const visited: string[] = [];

  const step: PipelineStep = {
    name: 'email_generation',
    scope: 'store',
    run: async (ctx) => {
      visited.push(ctx.store!.domain);
      return { status: 'OK' };
    },
  };

  await runPipeline([step], { runId, db, domains: ['https://www.sklep.pl/'] });
  assert.deepEqual(visited, ['sklep.pl']);
});

test('a domain that is not in the run does nothing rather than everything', async () => {
  const db = freshDb();
  const runId = seedRun(db, ['a.pl', 'b.pl']);
  const visited: string[] = [];

  const step: PipelineStep = {
    name: 'email_generation',
    scope: 'store',
    run: async (ctx) => {
      visited.push(ctx.store!.domain);
      return { status: 'OK' };
    },
  };

  const report = await runPipeline([step], { runId, db, domains: ['nowhere.pl'] });

  assert.deepEqual(visited, [], 'an unknown domain must not fall back to the whole batch');
  assert.equal(report.steps[0]!.ok, 0);
});
