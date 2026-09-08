import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, type Database } from '../../db/client.js';
import { migrate } from '../../db/migrate.js';
import { attachStoreToRun, createRun } from '../../db/repositories/runs.js';
import { upsertStore } from '../../db/repositories/stores.js';
import { saveAiAnalysis } from '../../db/repositories/aiAnalyses.js';
import { saveContacts } from '../../db/repositories/contacts.js';
import { listEmails } from '../../db/repositories/emails.js';
import type { StoreRow } from '../../db/types.js';
import { silentLogger } from '../../lib/logger.js';
import type { AiClient, CompletionRequest, CompletionResult } from '../../ai/client.js';
import { createEmailGenerationStep } from './emailGeneration.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'db', 'migrations');

function fakeClient(script: {
  writer?: string[];
  qc?: string[];
}): AiClient & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const counters = { outreach_email: 0, outreach_qc: 0 };
  return {
    calls,
    model: 'test-model',
    complete: async (request): Promise<CompletionResult> => {
      calls.push(request);
      const key = request.schemaName as keyof typeof counters;
      const replies = (key === 'outreach_qc' ? script.qc : script.writer) ?? [];
      const text = replies[Math.min(counters[key], replies.length - 1)] ?? '';
      counters[key] += 1;
      return { text, tokensIn: 120, tokensOut: 30, durationMs: 2, model: 'test-model' };
    },
  };
}

const BODY = `Anna, ${'słowo '.repeat(99)}`.trim();

const LETTER = JSON.stringify({
  subject: 'koszyk nie działa',
  body: BODY,
  factsUsed: ['A12'],
});

const QC_PASS = JSON.stringify({
  facts: { verdict: 'PASS', reason: 'traces to A12' },
  personalisation: { verdict: 'PASS', reason: 'specific' },
  category: { verdict: 'PASS', reason: 'on topic' },
  tone: { verdict: 'PASS', reason: 'plain' },
  pushiness: { verdict: 'PASS', reason: 'sells nothing' },
});

const ANALYST_OUTPUT = JSON.stringify({
  issues: [
    {
      evidenceId: 12,
      page: 'product',
      category: 'technical',
      severity: 'CRITICAL',
      title: 'Add to cart does nothing',
      impact: 'shoppers cannot buy on a phone',
    },
  ],
  scores: { ux: 40, cro: 40, seo: 60, performance: 30 },
  signals: { strengths: [], momentum: '', insufficientEvidence: false },
});

interface Fixture {
  db: Database;
  store: StoreRow;
  runId: number;
}

function fixture(options: { category?: string | null; contact?: boolean } = {}): Fixture {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  const run = createRun('PL', 1, db);
  const { store } = upsertStore({ domain: 'sklep.pl', url: 'https://sklep.pl' }, db);
  attachStoreToRun(run.id, store.id, db);

  if (options.category !== null) {
    saveAiAnalysis(
      {
        storeId: store.id,
        runId: run.id,
        agent: 'store_analyst',
        promptVersion: '1',
        output: ANALYST_OUTPUT,
      },
      db,
    );
    saveAiAnalysis(
      {
        storeId: store.id,
        runId: run.id,
        agent: 'lead_classifier',
        promptVersion: '1',
        category: options.category ?? 'TECHNICAL_PROBLEMS',
        reason: 'add to cart fails on the product page',
        leadScore: 90,
      },
      db,
    );
  }

  if (options.contact !== false) {
    saveContacts(
      store.id,
      [
        {
          name: 'Anna Kowalska',
          role: 'Founder',
          roleText: 'założycielka',
          email: 'anna@sklep.pl',
          linkedinUrl: null,
          source: 'about_page',
          sourceUrl: 'https://sklep.pl/o-nas',
          confidence: 0.9,
          isGeneric: false,
          evidence: 'about page',
        },
      ],
      db,
    );
  }

  return { db, store, runId: run.id };
}

function ctxFor(f: Fixture) {
  return {
    runId: f.runId,
    store: f.store,
    db: f.db,
    logger: silentLogger(),
    force: false,
    signal: new AbortController().signal,
  };
}

test('a classified store with a contact gets a READY letter', async () => {
  const f = fixture();
  const client = fakeClient({ writer: [LETTER], qc: [QC_PASS] });

  const outcome = await createEmailGenerationStep({ client }).run(ctxFor(f));
  assert.equal(outcome.status, 'OK');

  const [row] = listEmails(f.store.id, f.db);
  assert.equal(row?.status, 'READY');
  assert.equal(row?.version, 1);
  assert.equal(row?.word_count, 100);
  assert.equal(row?.category, 'TECHNICAL_PROBLEMS');
  assert.equal(row?.qc_passed, 1);
  // The letter is addressed to the contact the search found.
  assert.ok(row?.contact_id);
  f.db.close();
});

test('the letter is written for the contact the search named', async () => {
  const f = fixture();
  const client = fakeClient({ writer: [LETTER], qc: [QC_PASS] });
  await createEmailGenerationStep({ client }).run(ctxFor(f));

  const writerPrompt = client.calls.find((c) => c.schemaName === 'outreach_email')!.user;
  assert.match(writerPrompt, /Write to: Anna, Founder/);
  assert.match(writerPrompt, /\[A12\] Add to cart does nothing/);
  f.db.close();
});

test('a store with no classification is skipped without a call', async () => {
  const f = fixture({ category: null });
  const client = fakeClient({});

  const outcome = await createEmailGenerationStep({ client }).run(ctxFor(f));

  assert.equal(outcome.status, 'SKIPPED');
  assert.match((outcome.meta as { reason: string }).reason, /no lead classification/);
  assert.deepEqual(client.calls, []);
  assert.deepEqual(listEmails(f.store.id, f.db), []);
  f.db.close();
});

test('a healthy store is skipped and nothing is written', async () => {
  const f = fixture({ category: 'HEALTHY_STORE' });
  const client = fakeClient({ writer: [LETTER], qc: [QC_PASS] });

  const outcome = await createEmailGenerationStep({ client }).run(ctxFor(f));

  assert.equal(outcome.status, 'SKIPPED');
  assert.deepEqual(client.calls, [], 'no letter means no spend');
  assert.deepEqual(listEmails(f.store.id, f.db), []);
  f.db.close();
});

test('a refused draft is stored but the step reports it as skipped', async () => {
  const f = fixture();
  const client = fakeClient({
    writer: [LETTER],
    qc: [
      JSON.stringify({
        facts: { verdict: 'FAIL', reason: 'claims more than A12 supports' },
        personalisation: { verdict: 'PASS', reason: 'specific' },
        category: { verdict: 'PASS', reason: 'on topic' },
        tone: { verdict: 'PASS', reason: 'plain' },
        pushiness: { verdict: 'PASS', reason: 'sells nothing' },
      }),
    ],
  });

  const outcome = await createEmailGenerationStep({ client, rounds: 1 }).run(ctxFor(f));

  // A run report that counted this as a success would hide the failure.
  assert.equal(outcome.status, 'SKIPPED');
  const [row] = listEmails(f.store.id, f.db);
  assert.equal(row?.status, 'QC_FAILED');
  assert.equal(row?.qc_passed, 0);
  const checks = JSON.parse(row.qc_json!) as { name: string; reason: string }[];
  assert.match(checks[0]!.reason, /claims more than A12/);
  f.db.close();
});

test('a store whose letter is already READY is satisfied', async () => {
  const f = fixture();
  const client = fakeClient({ writer: [LETTER], qc: [QC_PASS] });
  const step = createEmailGenerationStep({ client });

  await step.run(ctxFor(f));
  const before = client.calls.length;

  assert.equal(step.isSatisfied?.(ctxFor(f)), true);
  assert.equal(client.calls.length, before, 'isSatisfied must not call the model');
  f.db.close();
});

test('a store whose only letter was refused is not satisfied', async () => {
  const f = fixture();
  const client = fakeClient({
    writer: [JSON.stringify({ subject: 's', body: 'krótko', factsUsed: [] })],
  });
  const step = createEmailGenerationStep({ client, rounds: 1, attemptsPerRound: 1 });

  await step.run(ctxFor(f));

  // A rejected draft is not done: the next run should try again.
  assert.equal(step.isSatisfied?.(ctxFor(f)), false);
  f.db.close();
});

test('a store with no contact still gets a letter, addressed to nobody', async () => {
  const f = fixture({ contact: false });
  const client = fakeClient({
    writer: [JSON.stringify({ subject: 'koszyk', body: 'słowo '.repeat(100), factsUsed: ['A12'] })],
    qc: [QC_PASS],
  });

  const outcome = await createEmailGenerationStep({ client }).run(ctxFor(f));

  assert.equal(outcome.status, 'OK');
  assert.equal(listEmails(f.store.id, f.db)[0]?.contact_id, null);
  assert.match(
    client.calls.find((c) => c.schemaName === 'outreach_email')!.user,
    /do not invent a name/,
  );
  f.db.close();
});

test('the step records what the letter cost and what it cited', async () => {
  const f = fixture();
  const client = fakeClient({ writer: [LETTER], qc: [QC_PASS] });

  const outcome = await createEmailGenerationStep({ client }).run(ctxFor(f));
  const meta = outcome.meta as Record<string, unknown>;

  assert.deepEqual(meta.facts, ['A12']);
  assert.equal(meta.rounds, 1);
  assert.equal(meta.words, 100);
  assert.equal(meta.tokensIn, 120);
  assert.equal(meta.qcTokensIn, 120);
  assert.equal(meta.comparedAgainst, 0);
  f.db.close();
});
