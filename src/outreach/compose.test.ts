import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiClient, CompletionRequest, CompletionResult } from '../ai/client.js';
import type { StoreContext } from '../ai/context.js';
import type { StoreAnalystOutput } from '../ai/agents/storeAnalyst.js';
import { composeEmail } from './compose.js';

/** Replies keyed by the schema asked for, so writer and reviewer can differ. */
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
      return { text, tokensIn: 100, tokensOut: 20, durationMs: 3, model: 'test-model' };
    },
  };
}

const CONTEXT = {
  version: '1',
  generatedAt: '2026-09-08T10:00:00.000Z',
  store: { id: 1, domain: 'sklep.pl', url: 'https://sklep.pl', name: 'Sklep', country: 'PL' },
  business: { productsCount: 240 },
  theme: null,
  apps: null,
  pagespeed: [],
  audit: null,
  meta: { maxBytes: 32000, truncated: false, trimmed: [], issuesOmitted: 0 },
} as unknown as StoreContext;

const ANALYSIS = {
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
} as StoreAnalystOutput;

const BODY = `Anna, ${'słowo '.repeat(99)}`.trim();

function letter(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    subject: 'koszyk nie działa',
    body: BODY,
    factsUsed: ['A12'],
    ...overrides,
  });
}

function qcVerdict(overrides: Record<string, unknown> = {}): string {
  const pass = (reason: string) => ({ verdict: 'PASS', reason });
  return JSON.stringify({
    facts: pass('traces to A12'),
    personalisation: pass('specific to this shop'),
    category: pass('about the broken cart'),
    tone: pass('plain'),
    pushiness: pass('sells nothing'),
    ...overrides,
  });
}

function options(client: AiClient, extra: Record<string, unknown> = {}) {
  return {
    client,
    context: CONTEXT,
    category: 'TECHNICAL_PROBLEMS' as const,
    analysis: ANALYSIS,
    contactName: 'Anna Kowalska',
    ...extra,
  };
}

test('a draft that passes checks and QC is READY', async () => {
  const client = fakeClient({ writer: [letter()], qc: [qcVerdict()] });
  const result = await composeEmail(options(client));

  assert.equal(result.status, 'READY');
  assert.equal(result.rounds, 1);
  assert.equal(result.qc?.passed, true);
  assert.equal(result.draft?.wordCount, 100);
  assert.equal(result.reason, null);
});

test('a shop with nothing wrong is passed over without a single call', async () => {
  const client = fakeClient({});
  const result = await composeEmail(options(client, { category: 'HEALTHY_STORE' }));

  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.draft, null);
  assert.deepEqual(client.calls, [], 'no letter means no spend');
  assert.match(result.reason ?? '', /invent a reason/);
});

test('a QC failure is handed back to the writer, verbatim', async () => {
  const client = fakeClient({
    writer: [letter()],
    qc: [
      qcVerdict({
        facts: { verdict: 'FAIL', reason: 'claims checkout is broken; A12 is the cart' },
      }),
      qcVerdict(),
    ],
  });
  const result = await composeEmail(options(client));

  assert.equal(result.status, 'READY');
  assert.equal(result.rounds, 2);
  const secondWrite = client.calls.filter((c) => c.schemaName === 'outreach_email')[1];
  assert.match(secondWrite!.user, /claims checkout is broken/);
});

test('a draft failing the free checks never reaches the paid reviewer', async () => {
  const client = fakeClient({ writer: [letter({ body: 'krótko' })], qc: [qcVerdict()] });
  const result = await composeEmail(options(client, { rounds: 1, attemptsPerRound: 1 }));

  assert.equal(result.status, 'QC_FAILED');
  assert.equal(client.calls.filter((c) => c.schemaName === 'outreach_qc').length, 0);
  assert.match(result.reason ?? '', /words/);
});

test('the loop is bounded and QC_FAILED is a legitimate outcome', async () => {
  const client = fakeClient({
    writer: [letter()],
    qc: [qcVerdict({ tone: { verdict: 'FAIL', reason: 'reads as bulk outreach' } })],
  });
  const result = await composeEmail(options(client, { rounds: 2 }));

  assert.equal(result.status, 'QC_FAILED');
  assert.equal(result.rounds, 2);
  assert.equal(client.calls.filter((c) => c.schemaName === 'outreach_qc').length, 2);
  // Everything is kept: 5-09 reads the reasons, and a human can still judge it.
  assert.ok(result.draft);
  assert.match(result.reason ?? '', /reads as bulk outreach/);
});

test('a letter that repeats an earlier one fails QC on repetition', async () => {
  const client = fakeClient({ writer: [letter()], qc: [qcVerdict()] });
  const result = await composeEmail(
    options(client, { earlier: [{ id: 4, store_id: 9, body: BODY }], rounds: 1 }),
  );

  assert.equal(result.status, 'QC_FAILED');
  assert.equal(result.repetition?.repeats, true);
  assert.deepEqual(result.repetition?.closest, { id: 4, storeId: 9 });
  assert.match(result.reason ?? '', /similar to an earlier letter/);
});

test('the first letter ever written is compared against nothing', async () => {
  const client = fakeClient({ writer: [letter()], qc: [qcVerdict()] });
  const result = await composeEmail(options(client));

  assert.equal(result.repetition?.similarity, 0);
  assert.equal(result.repetition?.compared, 0);
  assert.equal(result.status, 'READY');
});

test('the reviewer is given the word count rather than asked to count', async () => {
  const client = fakeClient({ writer: [letter()], qc: [qcVerdict()] });
  const result = await composeEmail(options(client));

  const length = result.qc?.checks.find((check) => check.name === 'length');
  assert.equal(length?.verdict, 'PASS');
  assert.match(length.reason, /100 words/);
});

test('an unknown category is written for, but not silently', async () => {
  const logged: { category?: unknown }[] = [];
  const logger = {
    warn: (data: { category?: unknown }) => logged.push(data),
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  } as never;

  const client = fakeClient({ writer: [letter()], qc: [qcVerdict()] });
  const result = await composeEmail(
    options(client, { category: 'HIGH_REVENUE_OPPORTUNITY', logger }),
  );

  assert.equal(result.status, 'READY');
  assert.deepEqual(logged[0]?.category, 'HIGH_REVENUE_OPPORTUNITY');
});
