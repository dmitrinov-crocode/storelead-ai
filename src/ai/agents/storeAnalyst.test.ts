import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiClient, CompletionRequest, CompletionResult } from '../client.js';
import type { StoreContext } from '../context.js';
import {
  AiOutputError,
  STORE_ANALYST_JSON_SCHEMA,
  STORE_ANALYST_PROMPT_VERSION,
  STORE_ANALYST_SYSTEM_PROMPT,
  analyseStore,
  applyGroundingGuard,
  buildStoreAnalystPrompt,
  clampScores,
  parseOutput,
  promptHash,
  storeAnalystOutputSchema,
} from './storeAnalyst.js';

/** A client that replays canned answers and records what it was asked. */
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
      return { text, tokensIn: 100, tokensOut: 20, durationMs: 5, model: 'test-model' };
    },
  };
}

function context(overrides: Partial<StoreContext> = {}): StoreContext {
  return {
    version: '1',
    generatedAt: '2026-09-07T10:00:00.000Z',
    store: {
      id: 1,
      domain: 'sklep.pl',
      url: 'https://sklep.pl',
      name: 'Sklep',
      country: 'PL',
      platform: 'shopify',
    },
    business: {
      rank: 1000,
      revenueEstimate: 500_000,
      trafficEstimate: 90_000,
      growthRate: 0.1,
      productsCount: 200,
      appsCount: 4,
    },
    theme: null,
    apps: null,
    pagespeed: [],
    audit: {
      id: 7,
      status: 'OK',
      blocked: false,
      finishedAt: '2026-09-07T09:00:00.000Z',
      error: null,
      counts: { CRITICAL: 1, MAJOR: 0, MINOR: 0 },
      pages: [],
      seo: { page: null, site: null },
      issues: [
        {
          id: 11,
          page: 'product',
          category: 'cro',
          severity: 'CRITICAL',
          title: 'Add to cart does nothing',
          source: 'playwright',
        },
        {
          id: 12,
          page: 'homepage',
          category: 'ux',
          severity: 'MAJOR',
          title: 'Page scrolls sideways',
          source: 'playwright',
        },
      ],
    },
    meta: { maxBytes: 32_000, truncated: false, trimmed: [], issuesOmitted: 0 },
    ...overrides,
  };
}

const VALID_ANSWER = JSON.stringify({
  issues: [
    {
      evidenceId: 11,
      page: 'product',
      category: 'cro',
      severity: 'CRITICAL',
      title: 'Shoppers cannot add anything to the basket',
      impact: 'Every product page visit is a lost order.',
    },
  ],
  scores: { ux: 60, cro: 10, seo: 70, performance: 45 },
  signals: {
    strengths: ['Fast homepage'],
    momentum: 'Recent theme update',
    insufficientEvidence: false,
  },
});

test('a valid answer is parsed, kept and stamped with the prompt version', async () => {
  const client = fakeClient([VALID_ANSWER]);
  const analysis = await analyseStore({ client, context: context() });

  assert.equal(analysis.output.issues.length, 1);
  assert.equal(analysis.output.issues[0]?.evidenceId, 11);
  assert.equal(analysis.attempts, 1);
  assert.deepEqual(analysis.dropped, []);
  assert.match(analysis.promptVersion, new RegExp(`^${STORE_ANALYST_PROMPT_VERSION}/ctx`));
  assert.equal(analysis.promptHash.length, 16);
  assert.equal(analysis.usage.tokensIn, 100);
  assert.equal(analysis.usage.tokensOut, 20);
});

test('the schema and the facts both reach the model', async () => {
  const client = fakeClient([VALID_ANSWER]);
  await analyseStore({ client, context: context() });

  const request = client.calls[0]!;
  assert.equal(request.jsonSchema, STORE_ANALYST_JSON_SCHEMA);
  assert.equal(request.schemaName, 'store_analysis');
  assert.match(request.user, /sklep\.pl/);
  assert.match(request.user, /"id":11/, 'the anchor ids have to be in the prompt');
  assert.match(request.system, /Never state a fact that is not in the input/);
});

// ------------------------------------------------------- task 3-04: retries

test('an unparseable answer is retried and the second attempt is used', async () => {
  const client = fakeClient(['I think the shop is fine, honestly.', VALID_ANSWER]);
  const analysis = await analyseStore({ client, context: context() });

  assert.equal(analysis.attempts, 2);
  assert.equal(analysis.output.issues.length, 1);
  assert.match(
    client.calls[1]!.user,
    /previous answer was rejected/,
    'the retry says what went wrong, or the model repeats itself',
  );
});

test('an answer that parses but breaks the schema is also retried', async () => {
  const wrongShape = JSON.stringify({ issues: [], scores: { ux: 'high' }, signals: {} });
  const client = fakeClient([wrongShape, VALID_ANSWER]);
  const analysis = await analyseStore({ client, context: context() });
  assert.equal(analysis.attempts, 2);
});

test('after the attempt budget the failure is final, not retried forever', async () => {
  const client = fakeClient(['nope']);
  await assert.rejects(
    () => analyseStore({ client, context: context(), attempts: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof AiOutputError);
      assert.equal(error.attempts, 2);
      assert.equal((error as unknown as { retryable: boolean }).retryable, false);
      return true;
    },
  );
  assert.equal(client.calls.length, 2, 'exactly the budget, no more');
});

// ------------------------------------------------ task 3-05: grounding guard

test('an issue citing an evidence id this audit never produced is dropped', () => {
  const output = storeAnalystOutputSchema.parse({
    issues: [
      {
        evidenceId: 11,
        page: 'product',
        category: 'cro',
        severity: 'CRITICAL',
        title: 'Real',
        impact: 'Real',
      },
      {
        evidenceId: 999,
        page: 'homepage',
        category: 'seo',
        severity: 'MAJOR',
        title: 'Invented',
        impact: 'Invented',
      },
    ],
    scores: { ux: 50, cro: 50, seo: 50, performance: 50 },
    signals: { strengths: [], momentum: '', insufficientEvidence: false },
  });

  const guarded = applyGroundingGuard(output, context());
  assert.deepEqual(
    guarded.output.issues.map((i) => i.evidenceId),
    [11],
  );
  assert.deepEqual(guarded.dropped, [
    { evidenceId: 999, title: 'Invented', reason: 'unknown-evidence-id' },
  ]);
});

test('the guard runs inside the normal path, not only when asked', async () => {
  const answer = JSON.stringify({
    issues: [
      {
        evidenceId: 404,
        page: 'homepage',
        category: 'ux',
        severity: 'MAJOR',
        title: 'Ungrounded',
        impact: 'None',
      },
    ],
    scores: { ux: 50, cro: 50, seo: 50, performance: 50 },
    signals: { strengths: [], momentum: '', insufficientEvidence: false },
  });
  const analysis = await analyseStore({ client: fakeClient([answer]), context: context() });
  assert.deepEqual(analysis.output.issues, []);
  assert.equal(analysis.dropped.length, 1);
});

// ------------------------------------------------------- task 3-06: scoring

test('scores outside 0-100 are clamped rather than stored as given', () => {
  assert.deepEqual(clampScores({ ux: 120, cro: -5, seo: 70.6, performance: 0 }), {
    ux: 100,
    cro: 0,
    seo: 71,
    performance: 0,
  });
});

test('scoring is a checklist of measured things, not a free judgement', () => {
  for (const criterion of ['ux (', 'cro (', 'seo (', 'performance (']) {
    assert.ok(
      STORE_ANALYST_SYSTEM_PROMPT.includes(criterion),
      `${criterion} has no checklist in the prompt`,
    );
  }
  assert.match(STORE_ANALYST_SYSTEM_PROMPT, /do not invent criteria/);
  assert.match(
    STORE_ANALYST_SYSTEM_PROMPT,
    /do not score a criterion the input\s+does not cover/,
    'an unmeasured criterion must be skipped, not guessed',
  );
  // Every scored key in the schema is one the checklist actually covers.
  const scores = (STORE_ANALYST_JSON_SCHEMA.properties as { scores: { required: string[] } }).scores
    .required;
  assert.deepEqual(scores, ['ux', 'cro', 'seo', 'performance']);
});

// --------------------------------------------------------- prompt integrity

test('a trimmed bundle tells the model what is missing', () => {
  const trimmed = context({
    meta: { maxBytes: 100, truncated: true, trimmed: ['evidence'], issuesOmitted: 4 },
  });
  const prompt = buildStoreAnalystPrompt(trimmed, '{}');
  assert.match(prompt, /trimmed to fit a size limit/);
  assert.match(prompt, /4 finding\(s\)/);
});

test('a blocked audit is announced, so silence is not read as a healthy shop', () => {
  const blocked = context({ audit: { ...context().audit!, blocked: true } });
  assert.match(buildStoreAnalystPrompt(blocked, '{}'), /blocked by bot protection/);
});

test('the prompt hash changes when the prompt changes', () => {
  const a = promptHash('system', 'user');
  assert.notEqual(a, promptHash('system', 'user with one more fact'));
  assert.equal(a, promptHash('system', 'user'));
});

test('a fenced answer is rejected rather than silently repaired', () => {
  const parsed = parseOutput('```json\n{"issues":[]}\n```');
  assert.equal(parsed.ok, false);
});
