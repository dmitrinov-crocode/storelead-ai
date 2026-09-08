import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { PagespeedError } from './client.js';
import { PagespeedClient } from './client.js';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf-8'),
  );
}

/** A real PageSpeed response for keyshorts.com, recorded 2026-09-01. */
const MOBILE_RUN = fixture('run-mobile');
/** Recorded from the live API on 2026-09-01 — a keyless call, quota limit zero. */
const QUOTA_EXCEEDED = fixture('quota-exceeded');

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A client whose fetch, clock and sleep are entirely under the test's control. */
function makeClient(
  responses: (Response | (() => Response | Promise<Response>))[],
  overrides: Partial<ConstructorParameters<typeof PagespeedClient>[0]> = {},
) {
  const calls: string[] = [];
  const slept: number[] = [];
  let index = 0;
  let clock = 0;

  const client = new PagespeedClient({
    apiKey: 'test-key',
    retryBaseDelayMs: 10,
    nowImpl: () => clock,
    sleepImpl: (ms) => {
      slept.push(Math.round(ms));
      clock += ms;
      return Promise.resolve();
    },
    fetchImpl: ((url: string) => {
      calls.push(url);
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      // A Response body reads once, so hand out a clone per call.
      return Promise.resolve(typeof next === 'function' ? next() : next!.clone());
    }) as unknown as typeof fetch,
    ...overrides,
  });

  return { client, calls, slept };
}

async function expectError(promise: Promise<unknown>): Promise<PagespeedError> {
  try {
    await promise;
  } catch (error) {
    return error as PagespeedError;
  }
  throw new Error('expected the call to reject');
}

test('asks for all four categories, the strategy and the key', () => {
  const { client } = makeClient([]);
  const url = new URL(client.buildUrl('https://keyshorts.com', 'mobile'));

  assert.equal(url.searchParams.get('url'), 'https://keyshorts.com');
  assert.equal(url.searchParams.get('strategy'), 'mobile');
  assert.deepEqual(url.searchParams.getAll('category'), [
    'performance',
    'accessibility',
    'best-practices',
    'seo',
  ]);
  assert.equal(url.searchParams.get('key'), 'test-key');
});

test('omits the key when none is configured', () => {
  const { client } = makeClient([], { apiKey: undefined });

  assert.equal(new URL(client.buildUrl('https://x.pl', 'desktop')).searchParams.has('key'), false);
});

test('returns extracted metrics alongside the raw response', async () => {
  const { client } = makeClient([json(MOBILE_RUN)]);

  const { metrics, raw } = await client.run('https://keyshorts.com', 'mobile');

  assert.equal(metrics.scores.performance, 70);
  assert.equal(metrics.strategy, 'mobile');
  // raw is what gets written to pagespeed_results.raw_json, untouched.
  assert.deepEqual(raw, MOBILE_RUN);
});

test('runs mobile before desktop, one request each', async () => {
  const { client, calls } = makeClient([json(MOBILE_RUN)]);

  const results = await client.runBoth('https://keyshorts.com');

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((r) => r.metrics.strategy),
    ['mobile', 'desktop'],
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /strategy=mobile/);
  assert.match(calls[1]!, /strategy=desktop/);
});

test('spaces requests according to the rate limit', async () => {
  const { client, slept } = makeClient([json(MOBILE_RUN)], { requestsPerSecond: 1 });

  await client.runBoth('https://keyshorts.com');

  // First call goes immediately; the second waits out the full interval.
  assert.deepEqual(slept, [1000]);
});

test('retries a 429 and honours Retry-After over the computed backoff', async () => {
  const { client, calls, slept } = makeClient([
    () =>
      json(QUOTA_EXCEEDED, {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '30' },
      }),
    () => json(MOBILE_RUN),
  ]);

  const { metrics } = await client.run('https://keyshorts.com', 'mobile');

  assert.equal(metrics.scores.performance, 70);
  assert.equal(calls.length, 2);
  // 30 s from the header, not the 10 ms base backoff.
  assert.equal(slept[0], 30_000);
});

test('gives up on a quota error after the retry budget, with the API message', async () => {
  const { client, calls } = makeClient([() => json(QUOTA_EXCEEDED, { status: 429 })], {
    maxRetries: 2,
  });

  const error = await expectError(client.run('https://keyshorts.com', 'mobile'));

  assert.equal(error.status, 429);
  assert.equal(error.retryable, true);
  assert.match(error.message, /Quota exceeded/);
  assert.equal(calls.length, 2);
});

test('treats a 403 carrying a quota reason as retryable, not as a bad key', async () => {
  // Older PSI deployments answer 403 with reason 'rateLimitExceeded'.
  const { client, calls } = makeClient([
    () =>
      json(
        {
          error: {
            code: 403,
            message: 'Rate Limit Exceeded',
            errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }],
          },
        },
        { status: 403 },
      ),
    () => json(MOBILE_RUN),
  ]);

  await client.run('https://keyshorts.com', 'mobile');

  assert.equal(calls.length, 2);
});

test('does not retry a rejected API key', async () => {
  const { client, calls } = makeClient([
    () =>
      json(
        { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } },
        { status: 400 },
      ),
  ]);

  const error = await expectError(client.run('https://keyshorts.com', 'mobile'));

  assert.equal(error.retryable, false);
  assert.match(error.message, /API key not valid/);
  assert.equal(calls.length, 1);
});

test('surfaces the Lighthouse error code and stops retrying an unloadable store', async () => {
  const { client, calls } = makeClient([
    () =>
      json(
        {
          error: {
            code: 500,
            message:
              'Lighthouse returned error: ERRORED_DOCUMENT_REQUEST. Lighthouse was unable to reliably load the page you requested. (Status code: 503)',
          },
        },
        { status: 500 },
      ),
  ]);

  const error = await expectError(client.run('https://shop.pl', 'mobile'));

  // A 500 is retryable in general — this one is the store's own failure.
  assert.equal(error.lighthouseErrorCode, 'ERRORED_DOCUMENT_REQUEST');
  assert.equal(error.retryable, false);
  assert.equal(calls.length, 1);
});

test('retries a genuine server error', async () => {
  const { client, calls } = makeClient([
    () => new Response('<html>backend error</html>', { status: 502 }),
    () => json(MOBILE_RUN),
  ]);

  await client.run('https://keyshorts.com', 'mobile');

  assert.equal(calls.length, 2);
});

test('reports a timeout as retryable', async () => {
  const { client } = makeClient([], {
    timeoutMs: 5,
    maxRetries: 1,
    fetchImpl: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as unknown as typeof fetch,
  });

  const error = await expectError(client.run('https://slow.pl', 'mobile'));

  assert.match(error.message, /timed out after 5ms/);
  assert.equal(error.retryable, true);
});

test('retries a truncated JSON body', async () => {
  const { client, calls } = makeClient([
    () => new Response('{"lighthouseResu', { status: 200 }),
    () => json(MOBILE_RUN),
  ]);

  await client.run('https://keyshorts.com', 'mobile');

  assert.equal(calls.length, 2);
});
