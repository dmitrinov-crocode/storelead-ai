import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoreContext } from '../ai/context.js';
import {
  LEAD_SCORE_MAX,
  LEAD_SCORE_WEIGHTS,
  computeLeadScore,
  explainLeadScore,
} from './leadScore.js';

function context(overrides: {
  business?: Partial<StoreContext['business']>;
  audit?: Partial<NonNullable<StoreContext['audit']>> | null;
  pagespeed?: StoreContext['pagespeed'];
  theme?: StoreContext['theme'];
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
          counts: { CRITICAL: 0, MAJOR: 0, MINOR: 0 },
          pages: [],
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
      name: null,
      country: 'PL',
      platform: 'shopify',
    },
    business: {
      rank: null,
      revenueEstimate: null,
      trafficEstimate: null,
      growthRate: null,
      productsCount: null,
      appsCount: null,
      ...overrides.business,
    },
    theme: overrides.theme ?? null,
    apps: null,
    pagespeed: overrides.pagespeed ?? [],
    audit,
    meta: { maxBytes: 32_000, truncated: false, trimmed: [], issuesOmitted: 0 },
  };
}

function pagespeed(performance: number | null): StoreContext['pagespeed'] {
  return [
    {
      strategy: 'mobile',
      performance,
      accessibility: null,
      bestPractices: null,
      seo: null,
      fcpMs: null,
      lcpMs: null,
      cls: null,
      inpMs: null,
      ttfbMs: null,
      speedIndexMs: null,
      fetchedAt: '2026-09-07T09:00:00.000Z',
    },
  ];
}

test('the weights sum to exactly one, so a perfect lead scores exactly 100', () => {
  const total = Object.values(LEAD_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(total * 1000) / 1000, 1);

  const best = computeLeadScore(
    context({
      business: { revenueEstimate: 5_000_000, trafficEstimate: 500_000, growthRate: 1 },
      audit: { counts: { CRITICAL: 10, MAJOR: 10, MINOR: 10 } },
      pagespeed: pagespeed(0),
      theme: {
        name: 'Vintage',
        currentVersion: null,
        latestVersion: null,
        versionGap: null,
        ageMonths: 60,
        architecture: 'vintage',
        freshness: 'severely_outdated',
      },
    }),
  );
  assert.equal(best.score, LEAD_SCORE_MAX);
  assert.equal(best.coverage, 1);
});

test('a flawless shop is a poor lead, not a good one', () => {
  const perfect = computeLeadScore(
    context({
      business: { revenueEstimate: 5_000_000, trafficEstimate: 500_000, growthRate: 1 },
      audit: { counts: { CRITICAL: 0, MAJOR: 0, MINOR: 0 } },
      pagespeed: pagespeed(100),
      theme: {
        name: 'Dawn',
        currentVersion: '15.3.0',
        latestVersion: '15.3.0',
        versionGap: 0,
        ageMonths: 0,
        architecture: 'os2',
        freshness: 'fresh',
      },
    }),
  );
  const broken = computeLeadScore(
    context({
      business: { revenueEstimate: 5_000_000, trafficEstimate: 500_000, growthRate: 1 },
      audit: { counts: { CRITICAL: 5, MAJOR: 5, MINOR: 5 } },
      pagespeed: pagespeed(20),
      theme: {
        name: 'Vintage',
        currentVersion: null,
        latestVersion: null,
        versionGap: null,
        ageMonths: 40,
        architecture: 'vintage',
        freshness: 'severely_outdated',
      },
    }),
  );
  assert.ok(broken.score > perfect.score, 'problems we can fix are what make the lead');
});

test('a tiny shop with the same problems scores lower', () => {
  const shared = {
    audit: { counts: { CRITICAL: 3, MAJOR: 3, MINOR: 3 } },
    pagespeed: pagespeed(30),
  };
  const big = computeLeadScore(
    context({ ...shared, business: { revenueEstimate: 1_500_000, trafficEstimate: 150_000 } }),
  );
  const tiny = computeLeadScore(
    context({ ...shared, business: { revenueEstimate: 12_000, trafficEstimate: 1_200 } }),
  );
  assert.ok(big.score > tiny.score);
});

test('a missing signal narrows the evidence instead of scoring zero', () => {
  const withRevenue = computeLeadScore(
    context({
      business: { revenueEstimate: 800_000 },
      audit: { counts: { CRITICAL: 2, MAJOR: 2, MINOR: 0 } },
    }),
  );
  const withoutRevenue = computeLeadScore(
    context({ audit: { counts: { CRITICAL: 2, MAJOR: 2, MINOR: 0 } } }),
  );

  assert.ok(withoutRevenue.coverage < withRevenue.coverage, 'coverage records what was unknown');
  assert.ok(
    withoutRevenue.score > 0,
    'a shop with no StoreLeads figures still scores on its findings',
  );
  const revenue = withoutRevenue.components.find((c) => c.signal === 'revenue')!;
  assert.equal(revenue.value, null);
  assert.match(revenue.basis, /no revenue estimate/);
});

test('a blocked audit does not pretend the shop has no problems', () => {
  const blocked = computeLeadScore(
    context({ business: { revenueEstimate: 800_000 }, audit: { blocked: true } }),
  );
  const issues = blocked.components.find((c) => c.signal === 'issues')!;
  assert.equal(issues.value, null);
  assert.match(issues.basis, /audit blocked/);
});

test('a store with nothing known at all scores zero rather than dividing by zero', () => {
  const empty = computeLeadScore(context({ audit: null }));
  assert.equal(empty.score, 0);
  assert.equal(empty.coverage, 0);
});

test('every component explains the number it contributed', () => {
  const result = computeLeadScore(
    context({
      business: { revenueEstimate: 500_000, trafficEstimate: 50_000, growthRate: 0.2 },
      audit: { counts: { CRITICAL: 1, MAJOR: 2, MINOR: 4 } },
      pagespeed: pagespeed(35),
    }),
  );
  const lines = explainLeadScore(result);
  assert.equal(lines.length, Object.keys(LEAD_SCORE_WEIGHTS).length);
  assert.ok(lines.some((l) => l.includes('1 critical, 2 major, 4 minor')));
  assert.ok(lines.some((l) => l.includes('not scored — theme age unknown')));
});

test('the score is stable: the same facts give the same number', () => {
  const facts = context({
    business: { revenueEstimate: 640_000, trafficEstimate: 44_000, growthRate: 0.08 },
    audit: { counts: { CRITICAL: 1, MAJOR: 3, MINOR: 7 } },
    pagespeed: pagespeed(41),
  });
  assert.equal(computeLeadScore(facts).score, computeLeadScore(facts).score);
});
