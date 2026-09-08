import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffDelay, StepError, TimeoutError, withRetry, withTimeout } from './retry.js';

/** Records the sleeps instead of taking them, so backoff costs no wall time. */
function fakeSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

test('a call that works is not retried', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('a retryable failure is retried up to the limit, then rethrown', async () => {
  const { delays, sleep } = fakeSleep();
  let calls = 0;

  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new StepError('transient', { retryable: true });
      },
      { attempts: 3, sleepImpl: sleep },
    ),
    /transient/,
  );

  assert.equal(calls, 3);
  assert.equal(delays.length, 2, 'no sleep after the final attempt');
});

test('a failure that will not fix itself is not retried at all', async () => {
  const { delays, sleep } = fakeSleep();
  let calls = 0;

  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        // A bad API key costs the same retry budget as a rate limit unless the
        // difference is stated.
        throw new StepError('bad key', { retryable: false });
      },
      { attempts: 5, sleepImpl: sleep },
    ),
    /bad key/,
  );

  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('a call that succeeds on a later attempt returns its value', async () => {
  const { sleep } = fakeSleep();
  let calls = 0;

  const result = await withRetry(
    async (attempt) => {
      calls += 1;
      if (attempt < 3) throw new StepError('not yet', { retryable: true });
      return `attempt ${attempt}`;
    },
    { attempts: 4, sleepImpl: sleep },
  );

  assert.equal(result, 'attempt 3');
  assert.equal(calls, 3);
});

test('a server-supplied delay overrides the computed backoff', async () => {
  const { delays, sleep } = fakeSleep();

  await assert.rejects(
    withRetry(
      async () => {
        throw new StepError('rate limited', { retryable: true });
      },
      {
        attempts: 2,
        sleepImpl: sleep,
        // What honours a `Retry-After` header.
        delayFor: () => 12_345,
      },
    ),
  );

  assert.deepEqual(delays, [12_345]);
});

test('returning null from delayFor falls back to the computed backoff', async () => {
  const { delays, sleep } = fakeSleep();

  await assert.rejects(
    withRetry(
      async () => {
        throw new StepError('transient', { retryable: true });
      },
      { attempts: 2, baseDelayMs: 1000, maxDelayMs: 1000, sleepImpl: sleep, delayFor: () => null },
    ),
  );

  assert.equal(delays.length, 1);
  assert.ok(delays[0]! >= 500 && delays[0]! <= 1000, `got ${delays[0]}`);
});

test('the caller is told about each retry', async () => {
  const { sleep } = fakeSleep();
  const seen: number[] = [];

  await assert.rejects(
    withRetry(
      async () => {
        throw new StepError('transient', { retryable: true });
      },
      { attempts: 3, sleepImpl: sleep, onRetry: (_error, attempt) => seen.push(attempt) },
    ),
  );

  assert.deepEqual(seen, [1, 2]);
});

test('backoff grows, is capped, and is jittered', () => {
  // Jitter keeps parallel stores from retrying in lockstep.
  for (const attempt of [1, 2, 3]) {
    const delay = backoffDelay(attempt, 1000, 8000);
    const ceiling = Math.min(1000 * 2 ** (attempt - 1), 8000);
    assert.ok(delay >= ceiling / 2 && delay <= ceiling, `attempt ${attempt}: ${delay}`);
  }
  assert.ok(backoffDelay(20, 1000, 8000) <= 8000, 'the cap holds however many attempts');
});

test('a call that finishes in time returns normally', async () => {
  const result = await withTimeout(async () => 'done', 1000, 'step');
  assert.equal(result, 'done');
});

test('a call that overruns is rejected with the label and the budget', async () => {
  await assert.rejects(
    withTimeout(() => new Promise(() => undefined), 10, 'audit (sklep.pl)'),
    (error: unknown) => {
      assert.ok(error instanceof TimeoutError);
      assert.match((error as Error).message, /audit \(sklep\.pl\)/);
      assert.match((error as Error).message, /10/);
      return true;
    },
  );
});

test('the signal is aborted when the budget runs out', async () => {
  // The promise is not cancelled for us; a caller owning a browser or a fetch
  // has to honour this, and cannot if it never fires.
  let aborted = false;
  await assert.rejects(
    withTimeout(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      10,
      'step',
    ),
  );
  assert.equal(aborted, true);
});

test('a timeout does not fire for a call that already returned', async () => {
  const result = await withTimeout(
    async (signal) => (signal.aborted ? 'late' : 'early'),
    50,
    'step',
  );
  assert.equal(result, 'early');
});
