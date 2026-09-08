import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiClient, CompletionRequest, CompletionResult } from '../client.js';
import type { StoreContext } from '../context.js';
import {
  LEAD_CATEGORIES,
  LEAD_CLASSIFIER_JSON_SCHEMA,
  LEAD_CLASSIFIER_SYSTEM_PROMPT,
  MODEL_CATEGORIES,
  PRIORITY_BANDS,
  buildLeadClassifierPrompt,
  classifyLead,
  priorityForScore,
} from './leadClassifier.js';
import { computeLeadScore } from '../../analysis/leadScore.js';
import { MIN_REVENUE, MIN_TRAFFIC, evaluateSkipRules } from './skipRules.js';
import type { StoreAnalystOutput } from './storeAnalyst.js';

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
      return { text, tokensIn: 50, tokensOut: 10, durationMs: 3, model: 'test-model' };
    },
  };
}

function context(overrides: {
  business?: Partial<StoreContext['business']>;
  audit?: Partial<NonNullable<StoreContext['audit']>> | null;
  pagespeed?: StoreContext['pagespeed'];
}): StoreContext {
  const audit =
    overrides.audit === null
      ? null
      : {
          id: 1,
          status: 'OK' as const,
          blocked: false,
          finishedAt: null,
          error: null,
          counts: { CRITICAL: 1, MAJOR: 2, MINOR: 3 },
          pages: [
            {
              page: 'homepage' as const,
              viewport: 'mobile' as const,
              url: 'https://sklep.pl',
              availability: 'ok' as const,
              httpStatus: 200,
              navigationMs: 900,
              screenshotId: null,
              checks: { run: 10, failed: 0 },
            },
          ],
          seo: { page: null, site: null },
          issues: [],
          ...overrides.audit,
        };

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
      rank: 5000,
      revenueEstimate: 400_000,
      trafficEstimate: 40_000,
      growthRate: 0.05,
      productsCount: 120,
      appsCount: 6,
      ...overrides.business,
    },
    theme: null,
    apps: null,
    pagespeed: overrides.pagespeed ?? [],
    audit,
    meta: { maxBytes: 32_000, truncated: false, trimmed: [], issuesOmitted: 0 },
  };
}

const ANSWER = JSON.stringify({
  category: 'UX_PROBLEMS',
  priority: 'HIGH',
  reason: 'Mobile performance is 24 and the product page has overlapping controls.',
});

test('there are exactly ten categories and the model may not pick SKIP', () => {
  assert.equal(LEAD_CATEGORIES.length, 10);
  assert.ok(LEAD_CATEGORIES.includes('SKIP'));
  assert.equal(MODEL_CATEGORIES.length, 9);
  assert.ok(!MODEL_CATEGORIES.includes('SKIP' as never), 'SKIP is a code verdict, not a judgement');
  assert.deepEqual(
    (LEAD_CLASSIFIER_JSON_SCHEMA.properties as { category: { enum: string[] } }).category.enum,
    [...MODEL_CATEGORIES],
  );
});

test('a classified store keeps the model category and the computed priority', async () => {
  const client = fakeClient([ANSWER]);
  const result = await classifyLead({ client, context: context({}) });

  assert.equal(result.category, 'UX_PROBLEMS');
  assert.equal(result.skip, null);
  assert.equal(result.priority, priorityForScore(result.leadScore.score));
  assert.equal(result.modelPriority, 'HIGH');
  assert.match(result.reason, /Mobile performance/);
  assert.equal(result.usage?.tokensIn, 50);
});

test('the model cannot talk the priority up: the score band decides', async () => {
  // A shop with almost nothing wrong and no figures scores low, whatever the
  // model asserts.
  const quiet = context({
    business: { revenueEstimate: 60_000, trafficEstimate: 4_000, growthRate: 0 },
    audit: { counts: { CRITICAL: 0, MAJOR: 0, MINOR: 1 } },
  });
  const result = await classifyLead({ client: fakeClient([ANSWER]), context: quiet });

  assert.ok(result.leadScore.score < PRIORITY_BANDS.high);
  assert.notEqual(result.priority, 'HIGH');
  assert.equal(result.modelPriority, 'HIGH', 'the disagreement is recorded, not thrown away');
});

test('the computed score and its breakdown reach the prompt', () => {
  const facts = context({});
  const prompt = buildLeadClassifierPrompt(facts, computeLeadScore(facts));
  assert.match(prompt, /Computed lead score: \d+\/100/);
  assert.match(prompt, /evidence coverage \d+%/);
  assert.match(prompt, /revenue \(weight 0\.25\)/);
});

test("the analyst's reading is passed on when there is one", () => {
  const analysis: StoreAnalystOutput = {
    issues: [
      {
        evidenceId: 1,
        page: 'product',
        category: 'cro',
        severity: 'CRITICAL',
        title: 'Add to cart fails',
        impact: 'No order can be placed.',
      },
    ],
    scores: { ux: 40, cro: 10, seo: 60, performance: 30 },
    signals: { strengths: [], momentum: '', insufficientEvidence: false },
  };
  const facts = context({});
  const prompt = buildLeadClassifierPrompt(facts, computeLeadScore(facts), analysis);
  assert.match(prompt, /\[CRITICAL\] Add to cart fails — No order can be placed\./);
  assert.match(prompt, /ux 40, cro 10/);
});

test('the prompt forbids inventing problems and allows a healthy verdict', () => {
  assert.match(
    LEAD_CLASSIFIER_SYSTEM_PROMPT,
    /Never introduce a problem the analyst did not report/,
  );
  assert.match(LEAD_CLASSIFIER_SYSTEM_PROMPT, /HEALTHY_STORE is a real answer/);
});

// ------------------------------------------------------ task 3-09: skip rules

test('a shop that never loaded is skipped without calling the model', async () => {
  const dead = context({
    audit: {
      status: 'FAILED',
      error: 'net::ERR_NAME_NOT_RESOLVED',
      counts: { CRITICAL: 0, MAJOR: 0, MINOR: 0 },
    },
  });
  const client = fakeClient([ANSWER]);
  const result = await classifyLead({ client, context: dead });

  assert.equal(result.category, 'SKIP');
  assert.equal(result.skip?.reason, 'no_storefront');
  assert.equal(client.calls.length, 0, 'no AI call is paid for a shop that is not there');
  assert.equal(result.usage, null);
});

test('a frozen Shopify shop is closed, not merely broken', () => {
  const frozen = context({
    audit: {
      pages: [
        {
          page: 'homepage',
          viewport: 'mobile',
          url: 'https://sklep.pl',
          availability: 'http_error',
          httpStatus: 402,
          navigationMs: 200,
          screenshotId: null,
          checks: { run: 0, failed: 0 },
        },
      ],
    },
  });
  const verdict = evaluateSkipRules(frozen);
  assert.equal(verdict.reason, 'closed');
  assert.match(verdict.detail, /HTTP 402/);
});

test('an empty catalogue is a shop in setup', () => {
  const verdict = evaluateSkipRules(context({ business: { productsCount: 0 } }));
  assert.equal(verdict.reason, 'closed');
});

test('too small means small on both counts, not one', () => {
  const both = evaluateSkipRules(
    context({ business: { revenueEstimate: MIN_REVENUE - 1, trafficEstimate: MIN_TRAFFIC - 1 } }),
  );
  assert.equal(both.reason, 'too_small');

  const onlyRevenue = evaluateSkipRules(
    context({ business: { revenueEstimate: MIN_REVENUE - 1, trafficEstimate: 50_000 } }),
  );
  assert.equal(onlyRevenue.skip, false, 'a busy shop with no revenue figure is still a shop');
});

test('a blocked audit is never a verdict about the shop', () => {
  const blocked = evaluateSkipRules(
    context({ audit: { blocked: true, pages: [], counts: { CRITICAL: 0, MAJOR: 0, MINOR: 0 } } }),
  );
  assert.equal(blocked.skip, false);
  assert.match(blocked.detail, /not a shop verdict/);
});

test('no contacts only counts once contacts have been looked for', () => {
  const facts = context({});
  assert.equal(evaluateSkipRules(facts, {}).skip, false, 'null means not looked yet');
  assert.equal(evaluateSkipRules(facts, { contactCount: null }).skip, false);
  assert.equal(evaluateSkipRules(facts, { contactCount: 0 }).reason, 'no_contacts');
  assert.equal(evaluateSkipRules(facts, { contactCount: 2 }).skip, false);
});

test('priority bands are ordered and cover the whole range', () => {
  assert.equal(priorityForScore(100), 'HIGH');
  assert.equal(priorityForScore(PRIORITY_BANDS.high), 'HIGH');
  assert.equal(priorityForScore(PRIORITY_BANDS.high - 1), 'MEDIUM');
  assert.equal(priorityForScore(PRIORITY_BANDS.medium), 'MEDIUM');
  assert.equal(priorityForScore(PRIORITY_BANDS.medium - 1), 'LOW');
  assert.equal(priorityForScore(0), 'LOW');
});
