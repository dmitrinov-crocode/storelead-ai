import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { AiClient, CompletionRequest, CompletionResult } from '../../ai/client.js';
import { createMemoryDb, type Database } from '../../db/client.js';
import { migrate } from '../../db/migrate.js';
import { listAnalyses } from '../../db/repositories/aiAnalyses.js';
import { createAudit, finishAudit, saveIssues } from '../../db/repositories/audits.js';
import { createRun } from '../../db/repositories/runs.js';
import { startStep } from '../../db/repositories/stepLogs.js';
import { upsertStore } from '../../db/repositories/stores.js';
import type { StoreRow } from '../../db/types.js';
import { silentLogger } from '../../lib/logger.js';
import { priorityForScore } from '../../ai/agents/leadClassifier.js';
import { createAiAnalysisStep, type AiAnalysisStepMeta } from './aiAnalysis.js';
import type { StepContext } from '../types.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'db', 'migrations');

const ANALYST_ANSWER = JSON.stringify({
  issues: [
    {
      evidenceId: 1,
      page: 'product',
      category: 'cro',
      severity: 'CRITICAL',
      title: 'Nothing can be added to the basket',
      impact: 'Every visit to a product page is a lost order.',
    },
  ],
  scores: { ux: 45, cro: 15, seo: 60, performance: 30 },
  signals: { strengths: [], momentum: 'none', insufficientEvidence: false },
});

const CLASSIFIER_ANSWER = JSON.stringify({
  category: 'TECHNICAL_PROBLEMS',
  priority: 'HIGH',
  reason: 'Add to cart fails on the product page.',
});

function fakeClient(replies: string[]): AiClient & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let index = 0;
  return {
    calls,
    model: 'test-model',
    complete: async (request): Promise<CompletionResult> => {
      calls.push(request);
      const text = replies[Math.min(index, replies.length - 1)] ?? '';
      index += 1;
      return { text, tokensIn: 900, tokensOut: 120, durationMs: 42, model: 'test-model' };
    },
  };
}

interface Fixture {
  db: Database;
  store: StoreRow;
  runId: number;
}

function fixture(
  storeOverrides: Record<string, unknown> = {},
  options: { issues?: boolean; auditStatus?: 'OK' | 'FAILED'; blocked?: boolean } = {},
): Fixture {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  const run = createRun('PL', 10, db);
  const store = upsertStore(
    {
      domain: 'sklep.pl',
      url: 'https://sklep.pl',
      name: 'Sklep',
      country: 'PL',
      platform: 'shopify',
      rank: 4000,
      revenue_estimate: 600_000,
      traffic_estimate: 50_000,
      growth_rate: 0.15,
      products_count: 180,
      apps_count: 5,
      ...storeOverrides,
    },
    db,
  ).store;

  const audit = createAudit(store.id, run.id, db);
  if (options.issues !== false) {
    saveIssues(
      audit.id,
      store.id,
      [
        {
          page: 'product',
          category: 'cro',
          severity: 'CRITICAL',
          title: 'Add to cart does nothing',
          evidence: [{ selector: 'button.add', url: 'https://sklep.pl/p/1' }],
        },
      ],
      db,
    );
  }
  finishAudit(
    audit.id,
    {
      status: options.auditStatus ?? 'OK',
      blocked: options.blocked ?? false,
      pages: {
        pages: [
          {
            page: 'homepage',
            viewport: 'mobile',
            url: 'https://sklep.pl',
            availability: 'ok',
            httpStatus: 200,
            navigationMs: 800,
            screenshotId: null,
            checks: [],
          },
        ],
        keyUrls: null,
        botProtection: null,
      },
      seo: { page: null, site: null },
    },
    db,
  );

  return { db, store, runId: run.id };
}

function stepContext(f: Fixture): StepContext {
  return {
    runId: f.runId,
    store: f.store,
    db: f.db,
    logger: silentLogger(),
    force: false,
    signal: new AbortController().signal,
  };
}

test('a healthy run writes both agents and the computed score', async () => {
  const f = fixture();
  const client = fakeClient([ANALYST_ANSWER, CLASSIFIER_ANSWER]);
  const step = createAiAnalysisStep({ client, screenshotsDir: '/nonexistent' });

  const outcome = await step.run(stepContext(f));
  assert.equal(outcome.status, 'OK');

  const rows = listAnalyses(f.store.id, f.db);
  assert.deepEqual(
    rows.map((r) => r.agent),
    ['store_analyst', 'lead_classifier'],
  );

  const classifier = rows[1]!;
  assert.equal(classifier.category, 'TECHNICAL_PROBLEMS');
  assert.equal(typeof classifier.lead_score, 'number');
  assert.ok(classifier.lead_score! > 0);
  assert.equal(classifier.status, 'OK');
  assert.match(classifier.reason!, /Add to cart fails/);

  // Task 3-10: the prompt version travels with the result.
  assert.match(rows[0]!.prompt_version, /^1\/ctx1\+[0-9a-f]{16}$/);
});

test('tokens and time land in the step meta (task 3-11)', async () => {
  const f = fixture();
  const step = createAiAnalysisStep({
    client: fakeClient([ANALYST_ANSWER, CLASSIFIER_ANSWER]),
    screenshotsDir: '/nonexistent',
  });
  const outcome = await step.run(stepContext(f));
  const meta = outcome.meta as AiAnalysisStepMeta;

  assert.equal(meta.usage?.length, 2);
  assert.equal(meta.usage?.[0]?.agent, 'store_analyst');
  assert.equal(meta.usage?.[0]?.tokensIn, 900);
  assert.equal(meta.usage?.[0]?.tokensOut, 120);
  assert.equal(meta.usage?.[1]?.agent, 'lead_classifier');
  // The stored priority is the score band, not the 'HIGH' the model asserted.
  assert.equal(meta.priority, priorityForScore(meta.leadScore!));
});

test('the analyst reading is not written back into audit_issues', async () => {
  const f = fixture();
  const step = createAiAnalysisStep({
    client: fakeClient([ANALYST_ANSWER, CLASSIFIER_ANSWER]),
    screenshotsDir: '/nonexistent',
  });
  await step.run(stepContext(f));

  const rows = f.db
    .prepare('SELECT source, COUNT(*) AS n FROM audit_issues GROUP BY source')
    .all() as { source: string; n: number }[];
  assert.equal(rows.length, 1, 'AI output must not become its own evidence');
  assert.equal(rows[0]!.source, 'playwright');
  assert.equal(rows[0]!.n, 1);
});

test('a dead storefront is skipped without paying for a call', async () => {
  const f = fixture({}, { auditStatus: 'FAILED', issues: false });
  const client = fakeClient([ANALYST_ANSWER, CLASSIFIER_ANSWER]);
  const step = createAiAnalysisStep({ client, screenshotsDir: '/nonexistent' });

  const outcome = await step.run(stepContext(f));
  assert.equal(outcome.status, 'SKIPPED');
  assert.equal(client.calls.length, 0);

  const rows = listAnalyses(f.store.id, f.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.category, 'SKIP');
  assert.equal(rows[0]!.status, 'SKIPPED');
});

test('zero contacts only skips once contact search has actually run', async () => {
  const f = fixture();
  const client = fakeClient([ANALYST_ANSWER, CLASSIFIER_ANSWER]);
  const step = createAiAnalysisStep({ client, screenshotsDir: '/nonexistent' });

  // No contact_search log yet: the store is analysed normally.
  assert.equal((await step.run(stepContext(f))).status, 'OK');

  // Once the search has run and found nobody, the same store is skipped.
  startStep({ runId: f.runId, storeId: f.store.id, step: 'contact_search' }, 1, f.db);
  const second = await step.run(stepContext(f));
  assert.equal(second.status, 'SKIPPED');
  assert.equal((second.meta as AiAnalysisStepMeta).skipped?.reason, 'no_contacts');
});

test('an unusable answer marks AI_FAILED and keeps the rest of the store', async () => {
  const f = fixture();
  const step = createAiAnalysisStep({
    client: fakeClient(['not json at all']),
    screenshotsDir: '/nonexistent',
    attempts: 2,
  });

  await assert.rejects(() => step.run(stepContext(f)));

  const rows = listAnalyses(f.store.id, f.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.agent, 'store_analyst');
  assert.equal(rows[0]!.status, 'AI_FAILED');
  assert.ok(rows[0]!.error);
  assert.equal(step.softFail, true, 'the audit and contacts already collected stay usable');
});

test('a missing API key skips instead of failing every store', async () => {
  const f = fixture();
  // Passed explicitly rather than unset in the environment: the config also
  // reads `.env`, so a test that deleted the variable would still find the real
  // key and spend a real call.
  const step = createAiAnalysisStep({ apiKey: undefined, screenshotsDir: '/nonexistent' });

  const outcome = await step.run(stepContext(f));
  assert.equal(outcome.status, 'SKIPPED');
  assert.match((outcome.meta as AiAnalysisStepMeta).skipped!.reason, /OPENAI_API_KEY/);
});

test('a store already analysed against the current audit is satisfied', async () => {
  const f = fixture();
  const step = createAiAnalysisStep({
    client: fakeClient([ANALYST_ANSWER, CLASSIFIER_ANSWER]),
    screenshotsDir: '/nonexistent',
  });
  const ctx = stepContext(f);

  assert.equal(step.isSatisfied!({ ...ctx }), false, 'nothing analysed yet');
  await step.run(ctx);
  assert.equal(step.isSatisfied!({ ...ctx }), true);
});
