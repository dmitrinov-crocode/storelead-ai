import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiClient, CompletionRequest, CompletionResult } from '../ai/client.js';
import type { StoreContext } from '../ai/context.js';
import type { StoreAnalystOutput } from '../ai/agents/storeAnalyst.js';
import { generateEmail } from './agent.js';
import { WORD_RANGE } from './prompt.js';

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
      return { text, tokensIn: 900, tokensOut: 200, durationMs: 7, model: 'test-model' };
    },
  };
}

const CONTEXT = {
  version: '1',
  generatedAt: '2026-09-08T10:00:00.000Z',
  store: {
    id: 1,
    domain: 'sklep.pl',
    url: 'https://sklep.pl',
    name: 'Sklep',
    country: 'PL',
    platform: 'shopify',
  },
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

function reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    subject: 'koszyk nie działa na telefonie',
    body: `Anna, ${'słowo '.repeat(99)}`.trim(),
    factsUsed: ['A12'],
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

test('a good draft comes back on the first attempt', async () => {
  const client = fakeClient([reply()]);
  const draft = await generateEmail(options(client));

  assert.equal(draft.passedChecks, true);
  assert.equal(draft.attempts, 1);
  assert.equal(draft.wordCount, 100);
  assert.deepEqual(
    draft.factsUsed.map((f) => f.id),
    ['A12'],
  );
  assert.equal(draft.category, 'TECHNICAL_PROBLEMS');
  assert.match(draft.promptVersion, /^1\/ctx/);
});

test('the prompt carries the fact sheet, the name and the language', async () => {
  const client = fakeClient([reply()]);
  await generateEmail(options(client));

  const user = client.calls[0]!.user;
  assert.match(user, /\[A12\] Add to cart does nothing/);
  assert.match(user, /Write to: Anna/);
  assert.match(user, /Write in: Polish/);
  // The classifier's reading is what makes this shop a lead.
  assert.match(user, /TECHNICAL_PROBLEMS/);
});

test('a shop that named nobody is told not to invent a name', async () => {
  const client = fakeClient([reply({ body: 'słowo '.repeat(100) })]);
  await generateEmail(options(client, { contactName: null }));

  assert.match(client.calls[0]!.user, /do not invent a name/);
});

test('a cited fact that is not on the sheet is dropped, not retried on', async () => {
  const client = fakeClient([reply({ factsUsed: ['A12', 'A999'] })]);
  const draft = await generateEmail(options(client));

  assert.equal(client.calls.length, 1, 'a mislabelled source is not a reason to regenerate');
  assert.deepEqual(draft.inventedFacts, ['A999']);
  assert.deepEqual(
    draft.factsUsed.map((f) => f.id),
    ['A12'],
  );
});

test('a letter grounded in nothing real is regenerated', async () => {
  const client = fakeClient([reply({ factsUsed: ['A999'] }), reply()]);
  const draft = await generateEmail(options(client));

  assert.equal(draft.attempts, 2);
  assert.equal(draft.passedChecks, true);
  // The retry is told exactly what was wrong.
  assert.match(client.calls[1]!.user, /cites no fact from the sheet/);
});

test('a too-long draft is regenerated with the word count in the feedback', async () => {
  const client = fakeClient([reply({ body: `Anna, ${'słowo '.repeat(300)}` }), reply()]);
  const draft = await generateEmail(options(client));

  assert.equal(draft.attempts, 2);
  assert.match(
    client.calls[1]!.user,
    new RegExp(`between ${WORD_RANGE.min} and ${WORD_RANGE.max}`),
  );
  assert.match(client.calls[1]!.user, /previous draft was rejected/);
});

test('an unparseable answer is retried', async () => {
  const client = fakeClient(['not json at all', reply()]);
  const draft = await generateEmail(options(client));

  assert.equal(draft.attempts, 2);
  assert.equal(draft.passedChecks, true);
});

test('a draft that never passes still comes back, marked failed', async () => {
  const client = fakeClient([reply({ body: 'krótko' })]);
  const draft = await generateEmail(options(client, { attempts: 2 }));

  // Losing it would throw away what 5-09 needs and leave the reviewer nothing.
  assert.equal(draft.passedChecks, false);
  assert.ok(draft.failures.length > 0);
  assert.equal(draft.body, 'krótko');
  assert.equal(client.calls.length, 2);
});

test('the retry loop is bounded', async () => {
  const client = fakeClient([reply({ body: 'krótko' })]);
  await generateEmail(options(client, { attempts: 3 }));
  assert.equal(client.calls.length, 3);
});

test('the best of several failed attempts is the one returned', async () => {
  const client = fakeClient([
    // Three failures: too short, no greeting, no fact.
    reply({ body: 'krótko', factsUsed: [] }),
    // One failure: too short only.
    reply({ body: 'Anna krótko' }),
  ]);
  const draft = await generateEmail(options(client, { attempts: 2 }));

  assert.equal(draft.body, 'Anna krótko');
  assert.deepEqual(
    draft.failures.map((f) => f.check),
    ['length'],
  );
});

test('usage is reported for the token accounting of 3-11', async () => {
  const client = fakeClient([reply()]);
  const draft = await generateEmail(options(client));

  assert.equal(draft.usage.tokensIn, 900);
  assert.equal(draft.usage.model, 'test-model');
  assert.ok(draft.promptHash.length > 0);
});

test('the category brief reaches the writer', async () => {
  const client = fakeClient([reply()]);
  await generateEmail(options(client, { category: 'REDESIGN_OPPORTUNITY' }));

  const user = client.calls[0]!.user;
  assert.match(user, /How to approach this one:/);
  assert.match(user, /Never say the shop looks old/);
});

test('each category gets its own angle, not a shared one', async () => {
  const seen = new Set<string>();
  for (const category of [
    'TECHNICAL_PROBLEMS',
    'PERFORMANCE_PROBLEMS',
    'HEAVY_APP_STACK',
  ] as const) {
    const client = fakeClient([reply()]);
    await generateEmail(options(client, { category }));
    const brief = client.calls[0]!.user.split('How to approach this one:')[1] ?? '';
    seen.add(brief);
  }
  assert.equal(seen.size, 3);
});

test('the writer is never handed the revenue estimates', async () => {
  const client = fakeClient([reply()]);
  await generateEmail(options(client, { category: 'HIGH_REVENUE_LOW_QUALITY' }));

  // Third-party estimates, often wrong, and quoting them reads as surveillance.
  const user = client.calls[0]!.user;
  assert.doesNotMatch(user, /revenueEstimate|trafficEstimate|500000/);
  assert.match(user, /Never mention their revenue/);
});
