import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoreLeadsError } from './client.js';
import { DEFAULT_FIELDS, FILTER_KEYS, MAX_PAGE_SIZE, StoreLeadsClient } from './client.js';

interface StubCall {
  url: string;
  headers: Record<string, string>;
}

/** Builds a client whose fetch and sleep are fully controlled by the test. */
function makeClient(
  responses: (Response | (() => Response | Promise<Response>))[],
  overrides: Partial<ConstructorParameters<typeof StoreLeadsClient>[0]> = {},
) {
  const calls: StubCall[] = [];
  const slept: number[] = [];
  let index = 0;
  let clock = 0;

  const client = new StoreLeadsClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.test/v1/all',
    retryBaseDelayMs: 10,
    nowImpl: () => clock,
    sleepImpl: (ms) => {
      slept.push(Math.round(ms));
      clock += ms;
      return Promise.resolve();
    },
    fetchImpl: ((url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      // A Response body can only be read once, so hand out a clone each time.
      return Promise.resolve(typeof next === 'function' ? next() : next!.clone());
    }) as unknown as typeof fetch,
    ...overrides,
  });

  return { client, calls, slept };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

test('sends the bearer token and accept header', async () => {
  const { client, calls } = makeClient([json({ domains: [] })]);
  await client.listDomains();

  assert.equal(calls[0]!.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0]!.headers.Accept, 'application/json');
});

test('builds a list query with country, sort, paging and fields', () => {
  const { client } = makeClient([json({})]);
  const url = new URL(client.buildListUrl({ country: 'pl', page: 2, pageSize: 10 }));

  assert.equal(url.pathname, '/v1/all/domain');
  assert.equal(url.searchParams.get(FILTER_KEYS.country), 'PL');
  assert.equal(url.searchParams.get('sort'), 'rank', 'ascending rank = best stores first');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('page_size'), '10');
  assert.equal(url.searchParams.get('fields'), DEFAULT_FIELDS.join(','));
});

test('caps page_size at the API maximum', () => {
  const { client } = makeClient([json({})]);
  const url = new URL(client.buildListUrl({ pageSize: 500 }));
  assert.equal(url.searchParams.get('page_size'), String(MAX_PAGE_SIZE));
});

test('supports descending sort and a platform filter', () => {
  const { client } = makeClient([json({})]);
  const url = new URL(client.buildListUrl({ sort: '-estimated_sales', platform: 'Shopify' }));
  assert.equal(url.searchParams.get('sort'), '-estimated_sales');
  assert.equal(url.searchParams.get(FILTER_KEYS.platform), 'shopify');
});

test('parses the list envelope', async () => {
  const payload = { domains: [{ name: 'shop.pl' }], pagination: { page: 0, total: 12 } };
  const { client } = makeClient([json(payload)]);
  assert.deepEqual(await client.listDomains(), payload);
});

test('spaces requests according to the rate limit', async () => {
  const { client, slept } = makeClient([json({ domains: [] })], { requestsPerSecond: 2 });
  await client.listDomains({ page: 0 });
  await client.listDomains({ page: 1 });
  assert.deepEqual(slept, [500], 'second request waits half a second');
});

test('retries 5xx and succeeds', async () => {
  const { client, calls } = makeClient([
    () => new Response('boom', { status: 503 }),
    () => json({ domains: [{ name: 'shop.pl' }] }),
  ]);

  const result = await client.listDomains();
  assert.equal(result.domains?.length, 1);
  assert.equal(calls.length, 2);
});

test('honours Retry-After on 429', async () => {
  const { client, slept } = makeClient([
    () => new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } }),
    () => json({ domains: [] }),
  ]);

  await client.listDomains();
  assert.ok(
    slept.includes(3000),
    `expected a 3000ms wait from Retry-After, got ${JSON.stringify(slept)}`,
  );
});

test('does not retry an invalid API key', async () => {
  const { client, calls } = makeClient([() => new Response('bad key', { status: 401 })]);

  await assert.rejects(client.listDomains(), (error: StoreLeadsError) => {
    assert.equal(error.status, 401);
    assert.equal(error.retryable, false);
    assert.match(error.message, /rejected the API key/);
    return true;
  });
  assert.equal(calls.length, 1, 'a bad key must not be retried');
});

test('does not retry a 400', async () => {
  const { client, calls } = makeClient([() => new Response('bad filter', { status: 400 })]);
  await assert.rejects(client.listDomains(), /rejected \(400\)/);
  assert.equal(calls.length, 1);
});

test('gives up after the configured number of attempts', async () => {
  const { client, calls } = makeClient([() => new Response('down', { status: 500 })], {
    maxRetries: 3,
  });
  await assert.rejects(client.listDomains(), /server error \(500\)/);
  assert.equal(calls.length, 3);
});

test('treats a network failure as retryable', async () => {
  let attempts = 0;
  const { client } = makeClient([], {
    fetchImpl: (() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(json({ domains: [] }));
    }) as unknown as typeof fetch,
  });

  await client.listDomains();
  assert.equal(attempts, 2);
});

test('surfaces a timeout as a retryable error', async () => {
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const { client } = makeClient([], {
    maxRetries: 1,
    fetchImpl: (() => Promise.reject(abortError)) as unknown as typeof fetch,
  });

  await assert.rejects(client.listDomains(), (error: StoreLeadsError) => {
    assert.match(error.message, /timed out/);
    assert.equal(error.retryable, true);
    return true;
  });
});

test('retries malformed JSON from a 200', async () => {
  const { client, calls } = makeClient([
    () =>
      new Response('{ truncated', { status: 200, headers: { 'content-type': 'application/json' } }),
    () => json({ domains: [] }),
  ]);
  await client.listDomains();
  assert.equal(calls.length, 2);
});

test('getDomain unwraps the envelope and maps 404 to null', async () => {
  const found = makeClient([json({ domain: { name: 'shop.pl' } })]);
  assert.deepEqual(await found.client.getDomain('shop.pl'), { name: 'shop.pl' });

  const missing = makeClient([() => new Response('not found', { status: 404 })]);
  assert.equal(await missing.client.getDomain('nope.pl'), null);
  assert.match(missing.calls[0]!.url, /\/domain\/nope\.pl$/);
});

test('requires an api key', () => {
  assert.throws(() => new StoreLeadsClient({ apiKey: '' }), /requires an apiKey/);
});
