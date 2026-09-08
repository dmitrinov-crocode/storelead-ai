import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Fact } from './facts.js';
import { countWords, runProgrammaticChecks } from './checks.js';

const FACT: Fact = { id: 'A1', kind: 'issue', text: 'add to cart fails', source: 'audit 1' };

/** 100 words: comfortably inside the window, so a test can vary one thing at a time. */
const BODY = `Anna, ${'słowo '.repeat(99)}`.trim();

function check(overrides: Partial<Parameters<typeof runProgrammaticChecks>[0]> = {}) {
  return runProgrammaticChecks({
    subject: 'add to cart fails on mobile',
    body: BODY,
    factsUsed: [FACT],
    contactName: 'Anna Kowalska',
    ...overrides,
  });
}

test('counting words ignores punctuation and collapses whitespace', () => {
  assert.equal(countWords('Anna, add to cart fails.'), 5);
  assert.equal(countWords('  one\n\ntwo   three  '), 3);
  assert.equal(countWords('— · —'), 0);
});

test('a letter inside the window with a name and a fact passes', () => {
  const result = check();
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.wordCount, 100);
});

test('a letter outside 80–150 words is refused, and told which way', () => {
  const short = check({ body: 'Anna, add to cart fails.' });
  assert.equal(short.passed, false);
  assert.match(short.failures[0]!.message, /too thin/);

  const long = check({ body: `Anna, ${'słowo '.repeat(200)}` });
  assert.match(long.failures[0]!.message, /Cut it down/);
});

test('a known contact who is never greeted fails the check', () => {
  const result = check({ body: 'słowo '.repeat(100) });
  assert.equal(result.passed, false);
  assert.equal(result.failures[0]?.check, 'greeting');
  assert.match(result.failures[0].message, /Anna/);
});

test('a Polish inflected greeting still counts as using the name', () => {
  // `Anno,` is the vocative — the same greeting, and the only correct one here.
  assert.equal(check({ body: `Anno, ${'słowo '.repeat(99)}` }).passed, true);
});

test('a name inside another word does not count as a greeting', () => {
  const result = check({ body: `analityka ${'słowo '.repeat(99)}`, contactName: 'Ana' });
  assert.equal(
    result.failures.some((f) => f.check === 'greeting'),
    true,
  );
});

test('a shop that named nobody is not asked to greet anyone', () => {
  const result = check({ body: 'słowo '.repeat(100), contactName: null });
  assert.equal(result.passed, true);
});

test('a letter grounded in nothing is refused', () => {
  const result = check({ factsUsed: [] });
  assert.equal(result.passed, false);
  assert.equal(result.failures[0]?.check, 'grounding');
});

test('bulk-outreach phrases are refused, in both languages', () => {
  for (const phrase of [
    'I hope this email finds you well',
    'happy to jump on a call',
    'Mam nadzieję, że u Państwa wszystko dobrze',
    'bezpłatna konsultacja',
  ]) {
    const result = check({ body: `Anna, ${phrase} ${'słowo '.repeat(95)}` });
    assert.equal(result.passed, false, phrase);
    assert.equal(
      result.failures.some((f) => f.check === 'phrases'),
      true,
      phrase,
    );
  }
});

test('a banned phrase in the subject is caught too', () => {
  const result = check({ subject: 'quick call about your store' });
  assert.equal(
    result.failures.some((f) => f.check === 'phrases'),
    true,
  );
});

test('an empty or overlong subject is refused', () => {
  assert.equal(check({ subject: '   ' }).failures[0]?.check, 'subject');
  assert.match(
    check({ subject: 'x'.repeat(61) }).failures.find((f) => f.check === 'subject')!.message,
    /under 60/,
  );
});

test('every failure carries a message the retry can use verbatim', () => {
  const result = check({ body: 'krótko', factsUsed: [], subject: '' });

  // Everything wrong at once: too short, no greeting, no fact, no subject.
  assert.deepEqual(
    result.failures.map((f) => f.check),
    ['length', 'greeting', 'grounding', 'subject'],
  );
  for (const failure of result.failures) {
    assert.ok(failure.message.length > 15, failure.check);
    assert.match(failure.message, /\.$|\d/);
  }
});
