import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from './rateLimiter.js';

/** Virtual clock: sleeping advances time instead of waiting for it. */
function fakeClock() {
  let current = 1000;
  const slept: number[] = [];
  return {
    now: () => current,
    sleep: (ms: number) => {
      slept.push(Math.round(ms));
      current += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      current += ms;
    },
    slept,
  };
}

test('the first request is not delayed', async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(2, clock);
  await limiter.acquire();
  assert.deepEqual(clock.slept, []);
});

test('spaces consecutive requests by the configured interval', async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(2, clock); // 2 rps -> 500ms apart

  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();

  assert.deepEqual(clock.slept, [500, 500]);
});

test('does not delay when enough time has already passed', async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(2, clock);

  await limiter.acquire();
  clock.advance(900); // caller spent longer than the interval doing work
  await limiter.acquire();

  assert.deepEqual(clock.slept, []);
});

test('serialises concurrent callers in arrival order', async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(4, clock); // 250ms apart
  const order: number[] = [];

  await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      await limiter.acquire();
      order.push(i);
    }),
  );

  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.deepEqual(clock.slept, [250, 250, 250]);
});

test('a rejected caller does not stall the queue', async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(2, clock);

  await assert.rejects(
    limiter.acquire().then(() => {
      throw new Error('request failed');
    }),
  );
  await limiter.acquire();
  assert.deepEqual(clock.slept, [500]);
});

test('rejects a nonsensical rate', () => {
  assert.throws(() => new RateLimiter(0), /requestsPerSecond/);
});
