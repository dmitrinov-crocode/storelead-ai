import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, type Database } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { attachStoreToRun, createRun } from '../db/repositories/runs.js';
import { upsertStore } from '../db/repositories/stores.js';
import { listRunSteps } from '../db/repositories/stepLogs.js';
import { listContacts } from '../db/repositories/contacts.js';
import { listEmails } from '../db/repositories/emails.js';
import { getLatestAnalysis } from '../db/repositories/aiAnalyses.js';
import { getLatestAudit } from '../db/repositories/audits.js';
import { AuditPool } from '../audit/pool.js';
import { createShopFixture } from '../audit/testing/shopFixture.js';
import { startFixtureServer, type FixtureServer } from '../audit/testing/fixtureServer.js';
import { createAuditStep } from './steps/audit.js';
import { createAiAnalysisStep } from './steps/aiAnalysis.js';
import { createContactSearchStep } from './steps/contactSearch.js';
import { createEmailGenerationStep } from './steps/emailGeneration.js';
import { runPipeline } from './orchestrator.js';
import { summariseRun } from './report.js';
import type { AiClient, CompletionRequest, CompletionResult } from '../ai/client.js';

/**
 * The pipeline end to end, on fixtures, with no network (task 7-02).
 *
 * Every step has its own test; this one exists for what those cannot see — that
 * the steps fit together. Each hands the next something through the database
 * rather than through a return value, and that seam is where a change breaks
 * quietly: the analyst writes an output shape the letter writer no longer reads,
 * the contact search stores a row the outreach step cannot address, a status
 * makes a later step skip a store it should have processed. All of that passes
 * a unit test suite and fails a real run.
 *
 * Nothing here touches the network. The storefront is a local fixture server,
 * the model is a scripted client, and the web search is off. What is exercised
 * is our own wiring, which is the part we can be wrong about.
 */

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'db', 'migrations');

/** A model that answers whatever the schema asks for, so no step needs the network. */
function scriptedClient(): AiClient & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const answers: Record<string, () => string> = {
    store_analysis: () =>
      JSON.stringify({
        issues: [
          {
            evidenceId: firstIssueId,
            page: 'cart',
            category: 'cro',
            severity: 'CRITICAL',
            title: 'Adding to cart does nothing',
            impact: 'shoppers cannot start an order',
          },
        ],
        scores: { ux: 40, cro: 30, seo: 60, performance: 50 },
        signals: { strengths: [], momentum: 'none', insufficientEvidence: false },
      }),
    lead_classification: () =>
      JSON.stringify({
        category: 'TECHNICAL_PROBLEMS',
        priority: 'HIGH',
        reason: 'add to cart fails on the cart page',
      }),
    outreach_email: () =>
      JSON.stringify({
        subject: 'koszyk zostaje pusty',
        body: `Anna, ${'słowo '.repeat(99)}`.trim(),
        factsUsed: [`A${firstIssueId}`],
      }),
    outreach_qc: () =>
      JSON.stringify({
        facts: { verdict: 'PASS', reason: 'traces to the cart finding' },
        personalisation: { verdict: 'PASS', reason: 'names this shop' },
        category: { verdict: 'PASS', reason: 'about the broken cart' },
        tone: { verdict: 'PASS', reason: 'plain' },
        pushiness: { verdict: 'PASS', reason: 'sells nothing' },
      }),
  };

  return {
    calls,
    model: 'fixture-model',
    complete: async (request): Promise<CompletionResult> => {
      calls.push(request);
      const answer = answers[request.schemaName];
      assert.ok(answer, `no scripted answer for ${request.schemaName}`);
      return {
        text: answer(),
        tokensIn: 500,
        tokensOut: 120,
        durationMs: 1,
        model: 'fixture-model',
      };
    },
  };
}

/** Filled once the audit has written its findings, so the analyst can cite a real one. */
let firstIssueId = 1;

let server: FixtureServer;
let pool: AuditPool;

before(async () => {
  const shop = createShopFixture({ brokenAddToCart: true });
  server = await startFixtureServer({
    ...shop.routes,
    '/pages/o-nas': {
      body:
        '<html><body><main><h1>O nas</h1>' +
        '<p>Sklep prowadzi Anna Kowalska, założycielka marki.</p>' +
        '<a href="mailto:anna@sklep.test">Anna</a>' +
        '<a href="mailto:info@sklep.test">Biuro</a>' +
        '</main></body></html>',
    },
  });
  pool = new AuditPool({ concurrency: 1, restartAfter: 0, session: { requestDelayMs: 0 } });
});

after(async () => {
  await pool.close();
  await server.close();
});

function seed(): { db: Database; runId: number; storeId: number } {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  const run = createRun('PL', 1, db);
  const { store } = upsertStore(
    { domain: 'sklep.test', url: server.url, name: 'Sklep', platform: 'shopify' },
    db,
  );
  attachStoreToRun(run.id, store.id, db);
  return { db, runId: run.id, storeId: store.id };
}

test('a store goes from an audit to a READY letter without touching the network', async () => {
  const { db, runId, storeId } = seed();
  const client = scriptedClient();

  // The audit first, so the analyst has a real finding id to cite: the grounding
  // guard of 3-05 drops an issue whose evidence does not exist.
  const auditReport = await runPipeline([createAuditStep({ pool })], { runId, db });
  assert.equal(auditReport.status, 'COMPLETED');

  const audit = getLatestAudit(storeId, db);
  assert.ok(audit, 'the audit step must have written an audit');
  const issues = db
    .prepare('SELECT id FROM audit_issues WHERE store_id = ? ORDER BY id')
    .all(storeId) as { id: number }[];
  assert.ok(issues.length > 0, 'the fixture shop has a broken cart, so findings are expected');
  firstIssueId = issues[0]!.id;

  const report = await runPipeline(
    [
      createAiAnalysisStep({ client, screenshotLimit: 0 }),
      createContactSearchStep({ pool, respectRobots: false, webSearch: null }),
      createEmailGenerationStep({ client }),
    ],
    { runId, db },
  );

  assert.equal(report.status, 'COMPLETED');
  for (const step of report.steps) {
    assert.equal(step.failed, 0, `${step.step} failed`);
  }

  // The seam each step hands the next through: analysis -> classification ->
  // contact -> letter, all of it via the database.
  assert.equal(getLatestAnalysis(storeId, 'lead_classifier', db)?.category, 'TECHNICAL_PROBLEMS');

  const contacts = listContacts(storeId, db);
  assert.deepEqual(
    contacts.map((contact) => contact.name),
    ['Anna Kowalska', null, null],
  );

  const [email] = listEmails(storeId, db);
  assert.equal(email?.status, 'READY');
  assert.equal(email?.category, 'TECHNICAL_PROBLEMS');
  assert.equal(email?.word_count, 100);
  // Addressed to the person the contact search found, not to nobody.
  assert.equal(email?.contact_id, contacts[0]?.id);

  // And the letter was written from the audit's own findings: the writer's fact
  // sheet carries an id that came out of `audit_issues`, not from thin air.
  const writer = client.calls.find((call) => call.schemaName === 'outreach_email');
  assert.ok(writer);
  assert.match(writer.user, new RegExp(`\\[A${firstIssueId}\\]`));
  assert.match(writer.user, /Adding to cart does nothing/);
  db.close();
});

test('the run report accounts for every step of a real run', async () => {
  const { db, runId, storeId } = seed();
  const client = scriptedClient();

  await runPipeline([createAuditStep({ pool })], { runId, db });
  firstIssueId = (
    db.prepare('SELECT id FROM audit_issues WHERE store_id = ? ORDER BY id').all(storeId) as {
      id: number;
    }[]
  )[0]!.id;
  await runPipeline([createAiAnalysisStep({ client, screenshotLimit: 0 })], { runId, db });

  const summary = summariseRun(runId, listRunSteps(runId, db));

  assert.deepEqual(
    summary.steps.map((step) => step.step),
    ['audit', 'ai_analysis'],
  );
  assert.equal(summary.totals.failed, 0);
  // Two agents ran, and the report counted both.
  assert.equal(summary.steps[1]?.tokensIn, 1000);
  assert.deepEqual(summary.storesCompleted, [storeId]);
  db.close();
});
