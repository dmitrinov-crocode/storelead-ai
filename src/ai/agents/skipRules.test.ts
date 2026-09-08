import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoreContext } from '../context.js';
import { evaluateSkipRules, MIN_REVENUE, MIN_TRAFFIC } from './skipRules.js';

function context(overrides: Record<string, unknown> = {}): StoreContext {
  return {
    version: '1',
    generatedAt: '2026-09-08T10:00:00.000Z',
    store: { id: 1, domain: 'sklep.pl', url: 'https://sklep.pl', name: 'Sklep', country: 'PL' },
    business: {
      rank: 1000,
      revenueEstimate: 500_000,
      trafficEstimate: 20_000,
      growthRate: null,
      productsCount: 240,
      appsCount: 10,
    },
    theme: null,
    apps: null,
    pagespeed: [],
    audit: {
      id: 1,
      status: 'COMPLETED',
      blocked: false,
      finishedAt: null,
      error: null,
      counts: { CRITICAL: 1, MAJOR: 0, MINOR: 0 },
      pages: [{ page: 'homepage', availability: 'ok', httpStatus: 200 }],
      seo: { page: null, site: null },
      issues: [],
    },
    meta: { maxBytes: 32000, truncated: false, trimmed: [], issuesOmitted: 0 },
    ...overrides,
  } as unknown as StoreContext;
}

function audit(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...(context().audit as unknown as Record<string, unknown>), ...overrides };
}

test('a normal shop is not skipped', () => {
  const verdict = evaluateSkipRules(context());
  assert.equal(verdict.skip, false);
  assert.equal(verdict.reason, null);
});

test('bot protection is not a verdict about the shop', () => {
  // It must be said before anything looks at the empty page list a blocked
  // audit leaves behind, or a defended shop reads as a dead one.
  const verdict = evaluateSkipRules(context({ audit: audit({ blocked: true, pages: [] }) }));

  assert.equal(verdict.skip, false);
  assert.match(verdict.detail, /not a shop verdict/);
});

test('a homepage that answers with a closed status skips the shop', () => {
  for (const status of [402, 403, 410]) {
    const verdict = evaluateSkipRules(
      context({
        audit: audit({ pages: [{ page: 'homepage', availability: 'ok', httpStatus: status }] }),
      }),
    );
    if (verdict.skip) {
      assert.equal(verdict.reason, 'closed', `HTTP ${status}`);
      assert.match(verdict.detail, new RegExp(String(status)));
    }
  }
});

test('no audit at all means there is no storefront to judge', () => {
  const verdict = evaluateSkipRules(context({ audit: null }));
  assert.equal(verdict.reason, 'no_storefront');
  assert.match(verdict.detail, /no audit on record/);
});

test('a failed audit carries its reason into the verdict', () => {
  const verdict = evaluateSkipRules(
    context({ audit: audit({ status: 'FAILED', error: 'DNS did not resolve' }) }),
  );
  assert.equal(verdict.reason, 'no_storefront');
  assert.match(verdict.detail, /DNS did not resolve/);
});

test('a shop where no page loaded is skipped', () => {
  const verdict = evaluateSkipRules(
    context({
      audit: audit({
        pages: [
          { page: 'homepage', availability: 'error', httpStatus: null },
          { page: 'product', availability: 'error', httpStatus: null },
        ],
      }),
    }),
  );
  assert.equal(verdict.reason, 'no_storefront');
});

test('an empty catalogue is a parked domain or a shop in setup', () => {
  const verdict = evaluateSkipRules(
    context({ business: { ...context().business, productsCount: 0 } }),
  );
  assert.equal(verdict.reason, 'closed');
  assert.match(verdict.detail, /catalogue is empty/);
});

test('a shop is only too small when both floors are breached', () => {
  const business = context().business;

  const both = evaluateSkipRules(
    context({
      business: { ...business, revenueEstimate: MIN_REVENUE - 1, trafficEstimate: MIN_TRAFFIC - 1 },
    }),
  );
  assert.equal(both.reason, 'too_small');

  // Low revenue with real traffic is a shop worth writing to, and vice versa.
  const revenueOnly = evaluateSkipRules(
    context({
      business: { ...business, revenueEstimate: MIN_REVENUE - 1, trafficEstimate: 50_000 },
    }),
  );
  assert.equal(revenueOnly.skip, false);

  const trafficOnly = evaluateSkipRules(
    context({ business: { ...business, revenueEstimate: 900_000, trafficEstimate: 10 } }),
  );
  assert.equal(trafficOnly.skip, false);
});

test('an unknown estimate never makes a shop too small', () => {
  const verdict = evaluateSkipRules(
    context({
      business: { ...context().business, revenueEstimate: null, trafficEstimate: null },
    }),
  );
  assert.equal(verdict.skip, false);
});

test('a shop with nobody to write to is skipped, but only once we have looked', () => {
  assert.equal(evaluateSkipRules(context(), { contactCount: 0 }).reason, 'no_contacts');

  // Null means "not looked yet", which is the normal state at analysis time —
  // contact search runs after this step.
  assert.equal(evaluateSkipRules(context(), { contactCount: null }).skip, false);
  assert.equal(evaluateSkipRules(context()).skip, false);
  assert.equal(evaluateSkipRules(context(), { contactCount: 3 }).skip, false);
});
