import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoreContext } from '../ai/context.js';
import type { StoreAnalystOutput } from '../ai/agents/storeAnalyst.js';
import { applyFactGuard, buildFactSheet, renderFactSheet, type Fact } from './facts.js';

function context(overrides: Partial<StoreContext> = {}): StoreContext {
  return {
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
    business: {
      rank: 1000,
      revenueEstimate: 500000,
      trafficEstimate: 10000,
      growthRate: 0.1,
      productsCount: 240,
      appsCount: 12,
    },
    theme: null,
    apps: null,
    pagespeed: [],
    audit: null,
    meta: { maxBytes: 32000, truncated: false, trimmed: [], issuesOmitted: 0 },
    ...overrides,
  };
}

function analysis(issues: StoreAnalystOutput['issues']): StoreAnalystOutput {
  return {
    issues,
    scores: { ux: 50, cro: 50, seo: 50, performance: 50 },
    signals: { strengths: [], momentum: '', insufficientEvidence: false },
  };
}

const ISSUE = {
  evidenceId: 12,
  page: 'product',
  category: 'technical',
  severity: 'CRITICAL',
  title: 'Add to cart does nothing',
  impact: 'shoppers cannot buy from the product page on a phone',
} as StoreAnalystOutput['issues'][number];

test('the sheet leads with the analyst findings, worst first', () => {
  const facts = buildFactSheet({
    context: context(),
    analysis: analysis([
      { ...ISSUE, evidenceId: 5, severity: 'MINOR', title: 'Small thing' },
      { ...ISSUE, evidenceId: 12, severity: 'CRITICAL' },
    ]),
  });

  assert.deepEqual(
    facts.slice(0, 2).map((f) => f.id),
    ['A12', 'A5'],
  );
  assert.match(facts[0]!.text, /Add to cart does nothing/);
  // The impact travels with it: a letter must say what it costs, not name a bug.
  assert.match(facts[0]!.text, /cannot buy/);
});

test('measurements are on the sheet, mobile before desktop', () => {
  const facts = buildFactSheet({
    context: context({
      pagespeed: [
        { strategy: 'desktop', performance: 80, lcpMs: 1800, cls: 0.01 },
        { strategy: 'mobile', performance: 24, lcpMs: 6400, cls: 0.31 },
      ] as StoreContext['pagespeed'],
    }),
  });

  assert.match(facts[0]!.text, /mobile: performance 24\/100, largest paint 6\.4s/);
  assert.equal(facts[0]!.id, 'P1');
  assert.match(facts[1]!.text, /desktop/);
});

test('a shop with nothing measured yields an empty sheet, not an invented one', () => {
  const facts = buildFactSheet({ context: context({ business: {} as never }) });
  assert.deepEqual(facts, []);
  assert.match(renderFactSheet(facts), /no facts were gathered/);
});

test('the sheet is capped so a letter cannot become a list', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...ISSUE, evidenceId: i + 1 }));
  const facts = buildFactSheet({ context: context(), analysis: analysis(many), maxFacts: 4 });
  assert.equal(facts.length, 4);
});

test('the guard keeps cited facts and reports invented ones', () => {
  const facts: Fact[] = [
    { id: 'A12', kind: 'issue', text: 'x', source: 's' },
    { id: 'P1', kind: 'pagespeed', text: 'y', source: 's' },
  ];

  const result = applyFactGuard(facts, ['a12', 'P1', 'A99', ' ']);

  assert.deepEqual(
    result.used.map((f) => f.id),
    ['A12', 'P1'],
  );
  assert.deepEqual(result.invented, ['A99']);
});

test('a fact cited twice is used once', () => {
  const facts: Fact[] = [{ id: 'A1', kind: 'issue', text: 'x', source: 's' }];
  assert.equal(applyFactGuard(facts, ['A1', 'A1']).used.length, 1);
});

test('a letter that cites nothing real keeps nothing', () => {
  const facts: Fact[] = [{ id: 'A1', kind: 'issue', text: 'x', source: 's' }];
  const result = applyFactGuard(facts, ['A7', 'B2']);

  assert.deepEqual(result.used, []);
  assert.equal(result.invented.length, 2);
});
