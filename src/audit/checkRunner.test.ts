import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckSuite, classifyNavigation, runCheck } from './checkRunner.js';
import { createIssue } from './issues.js';
import type { GotoResult } from './session.js';

const anIssue = () =>
  createIssue({
    page: 'homepage',
    category: 'technical',
    severity: 'MAJOR',
    title: 'Broken image',
  });

function gotoResult(overrides: Partial<GotoResult> & { status?: number }): GotoResult {
  const { status, ...rest } = overrides;
  return {
    response:
      status === undefined ? null : ({ status: () => status } as unknown as GotoResult['response']),
    error: null,
    durationMs: 120,
    ...rest,
  };
}

test('a successful check returns its issues', async () => {
  const outcome = await runCheck('images', async () => [anIssue()]);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.issues.length, 1);
  assert.equal(outcome.error, null);
});

test('a check that returns nothing is still a success', async () => {
  const outcome = await runCheck('nav', async () => undefined);
  assert.deepEqual(outcome.issues, []);
  assert.equal(outcome.status, 'ok');
});

test('a throwing check is recorded instead of propagating', async () => {
  const outcome = await runCheck('cart', () => {
    throw new Error('selector resolved to 0 elements');
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error!, /selector resolved/);
  assert.deepEqual(outcome.issues, []);
});

test('a hanging check is cut off by its own timeout', async () => {
  const outcome = await runCheck('hangs', () => new Promise(() => undefined), { timeoutMs: 50 });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error!, /timed out after 50ms/);
});

test('one broken check does not stop the rest of the suite', async () => {
  const suite = new CheckSuite();
  await suite.run('a', async () => [anIssue()]);
  await suite.run('b', () => Promise.reject(new Error('boom')));
  await suite.run('c', async () => [anIssue()]);

  assert.equal(suite.issues.length, 2, 'the working checks still report');
  assert.deepEqual(
    suite.failed.map((f) => f.name),
    ['b'],
  );
  assert.equal(suite.partial, true);
});

test('a suite where everything worked is not partial', async () => {
  const suite = new CheckSuite();
  await suite.run('a', async () => []);
  assert.equal(suite.partial, false);
  assert.equal(suite.outcomes.length, 1);
});

test('a page that loads is not an issue', () => {
  const verdict = classifyNavigation(gotoResult({ status: 200 }), {
    page: 'homepage',
    url: 'https://sklep.pl',
  });
  assert.deepEqual(verdict, { availability: 'ok', httpStatus: 200, issue: null });
});

test('an unreachable host is a critical finding, not a crash', () => {
  const verdict = classifyNavigation(
    gotoResult({ error: new Error('net::ERR_NAME_NOT_RESOLVED at https://sklep.pl') }),
    { page: 'homepage', url: 'https://sklep.pl' },
  );
  assert.equal(verdict.availability, 'unreachable');
  assert.equal(verdict.issue!.severity, 'CRITICAL');
  assert.match(verdict.issue!.evidence[0]!.text!, /ERR_NAME_NOT_RESOLVED/);
});

test('a navigation timeout is distinguished from an unreachable host', () => {
  const verdict = classifyNavigation(
    gotoResult({ error: new Error('page.goto: Timeout 30000ms exceeded.') }),
    { page: 'homepage', url: 'https://sklep.pl' },
  );
  assert.equal(verdict.availability, 'timeout');
  assert.match(verdict.issue!.title, /did not finish loading/);
});

test('4xx and 5xx are graded differently', () => {
  const notFound = classifyNavigation(gotoResult({ status: 404 }), {
    page: 'product',
    url: 'https://sklep.pl/p/1',
  });
  assert.equal(notFound.availability, 'http_error');
  assert.equal(notFound.httpStatus, 404);
  assert.equal(notFound.issue!.severity, 'MAJOR');
  assert.match(notFound.issue!.title, /HTTP 404/);

  const serverError = classifyNavigation(gotoResult({ status: 503 }), {
    page: 'product',
    url: 'https://sklep.pl/p/1',
  });
  assert.equal(serverError.issue!.severity, 'CRITICAL');
});

test('a response-less navigation is treated as unreachable', () => {
  const verdict = classifyNavigation(gotoResult({}), {
    page: 'cart',
    url: 'https://sklep.pl/cart',
  });
  assert.equal(verdict.availability, 'unreachable');
  assert.equal(verdict.httpStatus, null);
});
