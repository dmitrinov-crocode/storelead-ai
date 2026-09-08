import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser } from './browser.js';
import { AuditPool } from './pool.js';
import { sleep } from '../lib/time.js';

test('runs at most `concurrency` sessions at a time', async () => {
  const pool = new AuditPool({ concurrency: 2, session: { requestDelayMs: 0 } });
  let inFlight = 0;
  let peak = 0;

  try {
    const results = await pool.map([1, 2, 3, 4, 5, 6], async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(30);
      inFlight -= 1;
      return n * 2;
    });

    assert.deepEqual(
      results.map((r) => r.value),
      [2, 4, 6, 8, 10, 12],
    );
    assert.equal(peak, 2);
  } finally {
    await pool.close();
  }
});

test('every store gets its own contexts and they are all closed afterwards', async () => {
  const pool = new AuditPool({ concurrency: 2, session: { requestDelayMs: 0 } });
  try {
    const seen = await pool.map([1, 2, 3], async (_n, session) => {
      await session.context('desktop');
      await session.context('mobile');
      const browser = await pool.currentBrowser();
      return browser.contexts().length;
    });

    // Two contexts of my own, plus at most the two of a concurrent store.
    for (const result of seen) assert.ok(result.value! >= 2 && result.value! <= 4);
    const browser = await pool.currentBrowser();
    assert.equal(browser.contexts().length, 0, 'no context may outlive its store');
  } finally {
    await pool.close();
  }
});

test('a failing store fails alone', async () => {
  const pool = new AuditPool({ concurrency: 2, session: { requestDelayMs: 0 } });
  try {
    const results = await pool.map([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('storefront exploded');
      return n;
    });

    assert.deepEqual(
      results.map((r) => r.ok),
      [true, false, true],
    );
    assert.match(results[1]!.error!.message, /storefront exploded/);
    const browser = await pool.currentBrowser();
    assert.equal(browser.contexts().length, 0, 'a failed store must not leak its contexts');
  } finally {
    await pool.close();
  }
});

test('restarts the browser once the store budget is spent', async () => {
  const launched: Browser[] = [];
  const pool = new AuditPool({
    concurrency: 1,
    restartAfter: 2,
    session: { requestDelayMs: 0 },
    launch: async () => {
      const browser = await launchBrowser();
      launched.push(browser);
      return browser;
    },
  });

  try {
    const versions = await pool.map([1, 2, 3, 4, 5], async (_n, session) => {
      await session.context('desktop');
      return (await pool.currentBrowser()) === launched[0];
    });

    assert.equal(pool.restartCount, 2, 'five stores at a budget of two means two restarts');
    assert.deepEqual(
      versions.map((v) => v.value),
      [true, true, false, false, false],
    );
    assert.equal(launched[0]!.isConnected(), false, 'the replaced browser must be closed');
  } finally {
    await pool.close();
  }
});

test('restartAfter: 0 keeps a single browser for the whole run', async () => {
  let launches = 0;
  const pool = new AuditPool({
    concurrency: 1,
    restartAfter: 0,
    session: { requestDelayMs: 0 },
    launch: async () => {
      launches += 1;
      return launchBrowser();
    },
  });

  try {
    await pool.map([1, 2, 3, 4], async () => undefined);
    assert.equal(launches, 1);
    assert.equal(pool.restartCount, 0);
  } finally {
    await pool.close();
  }
});

test('close() shuts the browser down', async () => {
  const pool = new AuditPool({ concurrency: 1, session: { requestDelayMs: 0 } });
  const browser = await pool.currentBrowser();
  await pool.close();
  assert.equal(browser.isConnected(), false);
});

test('an empty store list launches nothing', async () => {
  let launches = 0;
  const pool = new AuditPool({
    launch: async () => {
      launches += 1;
      return launchBrowser();
    },
  });
  const results = await pool.map([], async () => undefined);
  assert.deepEqual(results, []);
  assert.equal(launches, 0);
  await pool.close();
});
