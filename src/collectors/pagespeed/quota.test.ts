import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PagespeedQuota } from './quota.js';

test('reserves up to the budget and then refuses', () => {
  const quota = new PagespeedQuota({ maxRequests: 2 });

  assert.equal(quota.reserve(), true);
  assert.equal(quota.reserve(), true);
  assert.equal(quota.reserve(), false);
  assert.equal(quota.used, 2);
  assert.equal(quota.remaining, 0);
  assert.equal(quota.state, 'budget-exhausted');
  assert.match(quota.reason ?? '', /budget spent \(2 per run\)/);
});

test('a tripped latch refuses everything, whatever the budget says', () => {
  const quota = new PagespeedQuota({ maxRequests: 100 });
  quota.reserve();

  quota.trip();

  assert.equal(quota.reserve(), false);
  assert.equal(quota.remaining, 0);
  assert.equal(quota.state, 'quota-exhausted');
  assert.match(quota.reason ?? '', /quota exhausted/);
  // The one request already spent is still counted.
  assert.equal(quota.used, 1);
});

test('has no reason to report while requests are allowed', () => {
  const quota = new PagespeedQuota({ maxRequests: 1 });

  assert.equal(quota.state, 'ok');
  assert.equal(quota.reason, null);
  assert.equal(quota.remaining, 1);
});

test('rejects a nonsensical budget', () => {
  assert.throws(() => new PagespeedQuota({ maxRequests: 0 }), /maxRequests must be > 0/);
});
