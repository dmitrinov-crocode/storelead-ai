import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiClient, CompletionRequest, CompletionResult } from '../ai/client.js';
import type { Fact } from './facts.js';
import { buildQcPrompt, reviewEmail, type QcCheckName, type QcReport } from './qc.js';

function fakeClient(replies: string[]): AiClient & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let index = 0;
  return {
    calls,
    model: 'test-model',
    complete: async (request): Promise<CompletionResult> => {
      calls.push(request);
      const text = replies[Math.min(index, replies.length - 1)] ?? '';
      index += 1;
      return { text, tokensIn: 700, tokensOut: 150, durationMs: 4, model: 'test-model' };
    },
  };
}

const FACTS: Fact[] = [
  {
    id: 'A12',
    kind: 'issue',
    text: 'Add to cart does nothing on the product page',
    source: 'audit 12',
  },
];

function verdicts(overrides: Record<string, { verdict: string; reason: string }> = {}): string {
  const pass = (reason: string) => ({ verdict: 'PASS', reason });
  return JSON.stringify({
    facts: pass('every claim traces to A12'),
    personalisation: pass('names the product page of this shop'),
    category: pass('about the broken cart, which is why it was a lead'),
    tone: pass('plain and direct'),
    pushiness: pass('asks a question, offers nothing'),
    ...overrides,
  });
}

function options(client: AiClient, extra: Record<string, unknown> = {}) {
  return {
    client,
    subject: 'koszyk nie działa na telefonie',
    body: 'Anna, przycisk dodania do koszyka nic nie robi na telefonie.',
    facts: FACTS,
    category: 'TECHNICAL_PROBLEMS' as const,
    contactName: 'Anna Kowalska',
    ...extra,
  };
}

function checkNamed(report: QcReport, name: QcCheckName) {
  return report.checks.find((check) => check.name === name);
}

test('a clean letter passes all five model checks', async () => {
  const client = fakeClient([verdicts()]);
  const report = await reviewEmail(options(client));

  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.usage?.tokensIn, 700);
});

test('a single FAIL fails the letter, however good the rest is', async () => {
  const client = fakeClient([
    verdicts({
      facts: { verdict: 'FAIL', reason: 'claims checkout is broken; the fact is the cart' },
    }),
  ]);
  const report = await reviewEmail(options(client));

  // A QC that weighs checks against each other passes an invented claim because
  // the tone was good, and an invented claim is what must never go out.
  assert.equal(report.passed, false);
  assert.deepEqual(report.failures, ['facts: claims checkout is broken; the fact is the cart']);
});

test('the reviewer sees the same fact sheet as the writer, and the letter', () => {
  const prompt = buildQcPrompt(options(fakeClient([])));

  assert.match(prompt, /\[A12\] Add to cart does nothing/);
  assert.match(prompt, /Subject: koszyk nie działa/);
  assert.match(prompt, /TECHNICAL_PROBLEMS/);
  assert.match(prompt, /The contact is called Anna/);
});

test('a shop that named nobody says so, so the greeting is not judged missing', () => {
  const prompt = buildQcPrompt(options(fakeClient([]), { contactName: null }));
  assert.match(prompt, /No contact was named/);
});

test('length is reported from the code result, not judged by the model', async () => {
  const client = fakeClient([verdicts()]);
  const report = await reviewEmail(options(client, { length: { wordCount: 240, passed: false } }));

  assert.equal(report.passed, false);
  assert.equal(checkNamed(report, 'length')?.verdict, 'FAIL');
  assert.match(checkNamed(report, 'length')!.reason, /240 words/);
  // The model was never asked to count.
  assert.doesNotMatch(client.calls[0]!.user, /word count/i);
});

test('a check nobody ran is reported as not checked, not as a pass', async () => {
  const client = fakeClient([verdicts()]);
  const report = await reviewEmail(options(client));

  assert.equal(checkNamed(report, 'repetition')?.verdict, 'NOT_CHECKED');
  assert.match(checkNamed(report, 'repetition')!.reason, /5-07/);
  // Silence must not read as approval, but it must not fail the letter either.
  assert.equal(report.passed, true);
});

test('a letter over the similarity threshold fails on repetition', async () => {
  const client = fakeClient([verdicts()]);
  const report = await reviewEmail(
    options(client, { repetition: { similarity: 0.82, threshold: 0.7 } }),
  );

  assert.equal(report.passed, false);
  assert.match(checkNamed(report, 'repetition')!.reason, /82% similar/);
});

test('the report covers all seven checks of the plan', async () => {
  const client = fakeClient([verdicts()]);
  const report = await reviewEmail(
    options(client, {
      length: { wordCount: 100, passed: true },
      repetition: { similarity: 0.1, threshold: 0.7 },
    }),
  );

  assert.deepEqual(
    report.checks.map((c) => c.name),
    ['facts', 'personalisation', 'category', 'tone', 'pushiness', 'length', 'repetition'],
  );
  assert.equal(report.passed, true);
});

test('an unparseable verdict is retried', async () => {
  const client = fakeClient(['not json', verdicts()]);
  const report = await reviewEmail(options(client));

  assert.equal(client.calls.length, 2);
  assert.equal(report.passed, true);
});

test('a reviewer that never answers fails the draft rather than waving it through', async () => {
  const client = fakeClient(['not json']);
  const report = await reviewEmail(options(client, { attempts: 2 }));

  assert.equal(report.passed, false);
  assert.match(report.failures[0]!, /did not return a usable verdict/);
  assert.equal(report.usage, null);
});

test('the reviewer is told that the sender’s own actions need no fact', () => {
  // naoko-store.pl was refused for "sprawdzałem NAOKO-STORE.pl" — a statement
  // about what we did, not about the shop — while the same opening passed on
  // every other letter in the batch. Inconsistency is worse than strictness.
  const client = fakeClient([verdicts()]);
  return reviewEmail(options(client)).then(() => {
    assert.match(client.calls[0]!.system, /What the sender says they themselves did/);
    assert.match(client.calls[0]!.system, /needs\s+no fact/);
  });
});
