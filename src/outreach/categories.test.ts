import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEAD_CATEGORIES } from '../ai/agents/leadClassifier.js';
import {
  briefFor,
  CATEGORY_BRIEFS,
  isKnownCategory,
  renderBrief,
  shouldWriteFor,
} from './categories.js';

test('every category the classifier can produce has a brief', () => {
  for (const category of LEAD_CATEGORIES) {
    assert.ok(CATEGORY_BRIEFS[category], category);
  }
});

test('a shop with nothing wrong gets no letter', () => {
  // Writing anyway produces the letter that invents a problem to justify the
  // contact — the one failure this epic exists to avoid.
  assert.equal(shouldWriteFor('HEALTHY_STORE'), false);
  assert.match(briefFor('HEALTHY_STORE').skipReason ?? '', /invent a reason/);
  assert.equal(renderBrief('HEALTHY_STORE'), '');
});

test('a shop the code rules skipped gets no letter', () => {
  assert.equal(shouldWriteFor('SKIP'), false);
  assert.match(briefFor('SKIP').skipReason ?? '', /3-09/);
});

test('every writable category says what to lead with and what to avoid', () => {
  for (const category of LEAD_CATEGORIES) {
    const brief = briefFor(category);
    if (!brief.write) continue;
    assert.ok(brief.angle && brief.angle.length > 40, `${category} angle`);
    assert.ok(brief.avoid && brief.avoid.length > 20, `${category} avoid`);
    assert.match(renderBrief(category), /Avoid:/);
  }
});

test('the high-revenue brief forbids quoting the estimates', () => {
  // StoreLeads figures are third-party estimates, often wrong, and quoting a
  // merchant their own numbers reads as surveillance.
  assert.match(briefFor('HIGH_REVENUE_LOW_QUALITY').avoid ?? '', /Never mention their revenue/);
});

test('the redesign brief forbids calling the shop dated', () => {
  // Somebody chose that design and may still be there.
  assert.match(briefFor('REDESIGN_OPPORTUNITY').avoid ?? '', /old, dated or ugly/);
});

test('the technical brief keeps the cause out of the letter', () => {
  assert.match(briefFor('TECHNICAL_PROBLEMS').avoid ?? '', /JavaScript exception/);
});

test('an unknown category falls back to a writable brief rather than crashing', () => {
  const brief = briefFor('NOT_A_CATEGORY' as never);
  assert.equal(brief.write, true);
});

test('a category outside the table is recognised as unknown', () => {
  // Stale seed data produced `HIGH_REVENUE_OPPORTUNITY` in the first real batch
  // and the fallback swallowed it without a word.
  assert.equal(isKnownCategory('HIGH_REVENUE_OPPORTUNITY'), false);
  assert.equal(isKnownCategory('HIGH_REVENUE_LOW_QUALITY'), true);
  for (const category of LEAD_CATEGORIES) assert.equal(isKnownCategory(category), true, category);
});
