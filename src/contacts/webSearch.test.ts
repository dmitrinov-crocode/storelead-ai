import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SearchBudget,
  type WebSearchProvider,
  type WebSearchQuery,
  type WebSearchResult,
} from '../collectors/websearch/provider.js';
import { searchStoreContacts } from './webSearch.js';

const TARGET = { domain: 'sklepanna.pl', name: 'Sklep Anna', country: 'PL' };

function profileHit(title: string, slug = 'anna-kowalska') {
  return { url: `https://pl.linkedin.com/in/${slug}`, title, snippet: null };
}

/** A provider that replays one canned result per call and records the queries. */
function fakeProvider(
  replies: Partial<WebSearchResult>[],
): WebSearchProvider & { queries: WebSearchQuery[] } {
  const queries: WebSearchQuery[] = [];
  let index = 0;
  return {
    name: 'fake',
    queries,
    search: async (query) => {
      queries.push(query);
      const reply = replies[Math.min(index, replies.length - 1)] ?? {};
      index += 1;
      return {
        provider: 'fake',
        query: query.query,
        hits: [],
        dropped: 0,
        usage: { tokensIn: 100, tokensOut: 10, durationMs: 5, model: 'fake', searches: 1 },
        ...reply,
      };
    },
  };
}

test('a titled person stops the search before the second query is paid for', async () => {
  const provider = fakeProvider([
    { hits: [profileHit('Anna Kowalska - CEO - Sklep Anna | LinkedIn')] },
  ]);

  const result = await searchStoreContacts(TARGET, { provider });

  assert.equal(provider.queries.length, 1);
  assert.equal(result.queries, 1);
  assert.equal(result.stoppedBecause, 'a titled person was found');
  assert.deepEqual(
    result.people.map((p) => [p.name, p.role]),
    [['Anna Kowalska', 'CEO']],
  );
});

test('the second query runs when the first found nobody', async () => {
  const provider = fakeProvider([
    { hits: [] },
    { hits: [profileHit('Anna Kowalska - Founder - Sklep Anna | LinkedIn')] },
  ]);

  const result = await searchStoreContacts(TARGET, { provider });

  assert.equal(provider.queries.length, 2);
  assert.equal(result.people.length, 1);
  assert.equal(result.stoppedBecause, 'a titled person was found');
});

test('only the templates 4-07 can read are ever sent', async () => {
  const provider = fakeProvider([{ hits: [] }]);

  await searchStoreContacts(TARGET, { provider, maxQueries: 5 });

  // The open-web template of 4-06 has no reader yet, so paying for it would buy
  // a result nothing consumes.
  assert.equal(provider.queries.length, 2);
  for (const query of provider.queries) {
    assert.deepEqual(query.allowedDomains, ['linkedin.com']);
    assert.equal(query.country, 'PL');
  }
});

test('the run budget stops the search mid-store', async () => {
  const provider = fakeProvider([{ hits: [] }]);
  const budget = new SearchBudget({ maxSearches: 1 });

  const result = await searchStoreContacts(TARGET, { provider, budget });

  assert.equal(provider.queries.length, 1);
  assert.equal(result.queries, 1);
  assert.match(result.stoppedBecause ?? '', /budget spent/);
});

test('an exhausted budget sends nothing at all', async () => {
  const provider = fakeProvider([{ hits: [] }]);
  const budget = new SearchBudget({ maxSearches: 0 });

  const result = await searchStoreContacts(TARGET, { provider, budget });

  assert.equal(provider.queries.length, 0);
  assert.deepEqual(result.people, []);
});

test('a failed query keeps what the earlier one found', async () => {
  let call = 0;
  const provider: WebSearchProvider = {
    name: 'fake',
    search: async (query) => {
      call += 1;
      if (call === 1) {
        return {
          provider: 'fake',
          query: query.query,
          // A name with no role: not enough to stop, so a second query follows.
          hits: [profileHit('Anna Kowalska - Sklep Anna | LinkedIn')],
          dropped: 0,
          usage: null,
        };
      }
      throw new Error('rate limited');
    },
  };

  const result = await searchStoreContacts(TARGET, { provider });

  assert.deepEqual(
    result.people.map((p) => p.name),
    ['Anna Kowalska'],
  );
  assert.equal(result.stoppedBecause, 'rate limited');
});

test('usage is summed across the queries a store cost', async () => {
  const provider = fakeProvider([{ hits: [] }, { hits: [] }]);

  const result = await searchStoreContacts(TARGET, { provider });

  assert.equal(result.queries, 2);
  assert.equal(result.searches, 2);
  assert.equal(result.tokensIn, 200);
  assert.equal(result.tokensOut, 20);
  assert.equal(result.provider, 'fake');
});

test('the same profile returned by both queries is one person', async () => {
  const provider = fakeProvider([
    { hits: [profileHit('Anna Kowalska - Sklep Anna | LinkedIn')] },
    { hits: [profileHit('Anna Kowalska - Sklep Anna | LinkedIn', 'anna-kowalska')] },
  ]);

  const result = await searchStoreContacts(TARGET, { provider });

  assert.equal(result.people.length, 1);
  assert.equal(result.hits, 2);
});

test('hits the provider dropped are reported, not hidden', async () => {
  const provider = fakeProvider([
    { hits: [], dropped: 3 },
    { hits: [], dropped: 1 },
  ]);

  const result = await searchStoreContacts(TARGET, { provider });

  // Summed across both queries: a provider quietly discarding most of what it
  // returns is a broken template, and the count is how that becomes visible.
  assert.equal(result.dropped, 4);
});
