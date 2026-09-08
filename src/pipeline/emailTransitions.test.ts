import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canTransition,
  EmailTransitionError,
  HUMAN_TRANSITIONS,
  isHumanDecision,
  SUPERSEDABLE,
} from './emailTransitions.js';
import { EMAIL_STATUSES } from './status.js';

test('approving is only legal from READY', () => {
  // The one misclick that puts an unchecked claim in front of a merchant.
  assert.equal(canTransition('READY', 'APPROVED'), true);
  for (const status of EMAIL_STATUSES) {
    if (status === 'READY') continue;
    assert.equal(canTransition(status, 'APPROVED'), false, status);
  }
});

test('skipping is legal from every state the machine owns, and none it does not', () => {
  for (const status of ['DRAFT', 'QC_FAILED', 'READY'] as const) {
    assert.equal(canTransition(status, 'SKIPPED'), true, status);
  }
  for (const status of ['APPROVED', 'SKIPPED'] as const) {
    assert.equal(canTransition(status, 'SKIPPED'), false, status);
  }
});

test('a decision is only ever one of two words', () => {
  assert.equal(isHumanDecision('APPROVED'), true);
  assert.equal(isHumanDecision('SKIPPED'), true);
  for (const value of ['READY', 'approved', '', null, undefined, 1, {}]) {
    assert.equal(isHumanDecision(value), false, JSON.stringify(value) ?? 'undefined');
  }
});

test('a superseded version is one the machine still owns', () => {
  // A human's decision is never overwritten by a later draft.
  assert.deepEqual([...SUPERSEDABLE], ['DRAFT', 'QC_FAILED', 'READY']);
  for (const status of ['APPROVED', 'SKIPPED']) {
    assert.equal(SUPERSEDABLE.includes(status as never), false, status);
  }
});

test('every listed source status is a real email status', () => {
  for (const [decision, sources] of Object.entries(HUMAN_TRANSITIONS)) {
    for (const source of sources) {
      assert.ok(EMAIL_STATUSES.includes(source), `${decision} from ${source}`);
    }
  }
});

test('the error names both ends of the refused move', () => {
  const error = new EmailTransitionError('DRAFT', 'APPROVED');
  assert.match(error.message, /DRAFT/);
  assert.match(error.message, /APPROVED/);
  assert.equal(error.name, 'EmailTransitionError');
});
