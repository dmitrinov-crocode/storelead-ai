import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countBySeverity,
  createIssue,
  dedupeIssues,
  MAX_EVIDENCE,
  normalizeEvidence,
  sortIssues,
  type Issue,
} from './issues.js';

function issue(overrides: Partial<Parameters<typeof createIssue>[0]> = {}): Issue {
  return createIssue({
    page: 'homepage',
    category: 'technical',
    severity: 'MAJOR',
    title: 'Broken image',
    ...overrides,
  });
}

test('an issue defaults to the Playwright source and an empty evidence list', () => {
  const result = issue();
  assert.equal(result.source, 'playwright');
  assert.deepEqual(result.evidence, []);
});

test('a single evidence object is accepted as well as a list', () => {
  assert.equal(issue({ evidence: { selector: 'img.hero' } }).evidence.length, 1);
  assert.equal(issue({ evidence: [{ selector: 'a' }, { selector: 'b' }] }).evidence.length, 2);
});

test('an issue without a title is rejected', () => {
  assert.throws(() => issue({ title: '   ' }), /must have a title/);
});

test('evidence drops empty fields and keeps a count only when it matters', () => {
  assert.deepEqual(normalizeEvidence({ selector: '', text: 'boom', count: 1 }), { text: 'boom' });
  assert.deepEqual(normalizeEvidence({ text: 'boom', count: 4 }), { text: 'boom', count: 4 });
  assert.deepEqual(normalizeEvidence({ status: 404, url: '/x' }), { status: 404, url: '/x' });
  assert.deepEqual(normalizeEvidence({}), {});
});

test('evidence with only empty fields is not stored at all', () => {
  assert.deepEqual(issue({ evidence: [{ selector: '' }, { text: 'real' }] }).evidence, [
    { text: 'real' },
  ]);
});

test('long text is truncated so one issue cannot bloat the database', () => {
  const long = 'x'.repeat(5000);
  const result = issue({ title: long, detail: long, evidence: { text: long } });
  assert.ok(result.title.length <= 200);
  assert.ok(result.detail!.length <= 2000);
  assert.ok(result.evidence[0]!.text!.length <= 500);
  assert.match(result.title, /…$/);
});

test('evidence is capped', () => {
  const many = Array.from({ length: MAX_EVIDENCE + 5 }, (_, i) => ({
    selector: `img:nth-child(${i})`,
  }));
  assert.equal(issue({ evidence: many }).evidence.length, MAX_EVIDENCE);
});

test('duplicate findings merge, keeping the worse severity and both proofs', () => {
  const merged = dedupeIssues([
    issue({ severity: 'MAJOR', evidence: { url: '/a.png', status: 404 } }),
    issue({ severity: 'CRITICAL', evidence: { selector: 'img.hero' }, detail: 'hero is blank' }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.severity, 'CRITICAL');
  assert.equal(merged[0]!.evidence.length, 2);
  assert.equal(merged[0]!.detail, 'hero is blank');
});

test('identical evidence is not duplicated by the merge', () => {
  const merged = dedupeIssues([
    issue({ evidence: { url: '/a.png', status: 404 } }),
    issue({ evidence: { url: '/a.png', status: 404 } }),
  ]);
  assert.equal(merged[0]!.evidence.length, 1);
});

test('issues on different pages stay separate', () => {
  const merged = dedupeIssues([issue({ page: 'homepage' }), issue({ page: 'product' })]);
  assert.equal(merged.length, 2);
});

test('sorting puts the worst finding first, then follows the shopping funnel', () => {
  const sorted = sortIssues([
    issue({ severity: 'MINOR', page: 'homepage', title: 'Small text' }),
    issue({ severity: 'CRITICAL', page: 'checkout', title: 'Checkout fails' }),
    issue({ severity: 'CRITICAL', page: 'site', title: 'Site is down' }),
    issue({ severity: 'MAJOR', page: 'product', title: 'No price' }),
  ]);

  assert.deepEqual(
    sorted.map((i) => i.title),
    ['Site is down', 'Checkout fails', 'No price', 'Small text'],
  );
});

test('countBySeverity reports every level, including the empty ones', () => {
  const counts = countBySeverity([
    issue({ severity: 'CRITICAL' }),
    issue({ severity: 'CRITICAL', title: 'Other' }),
    issue({ severity: 'MINOR', title: 'Third' }),
  ]);
  assert.deepEqual(counts, { CRITICAL: 2, MAJOR: 0, MINOR: 1 });
});
