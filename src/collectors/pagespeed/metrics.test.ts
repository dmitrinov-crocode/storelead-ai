import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { extractMetrics } from './metrics.js';
import type { PagespeedResponse } from './types.js';

function fixture(name: string): PagespeedResponse {
  return JSON.parse(
    readFileSync(path.join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf-8'),
  ) as PagespeedResponse;
}

/** A real PageSpeed response for keyshorts.com, recorded 2026-09-01. */
const mobile = fixture('run-mobile');

test('maps the four category scores from 0..1 to 0..100', () => {
  const metrics = extractMetrics(mobile, 'mobile');

  assert.deepEqual(metrics.scores, {
    performance: 70,
    accessibility: 93,
    bestPractices: 92,
    seo: 92,
  });
});

test('takes the lab timings and rounds them to whole milliseconds', () => {
  const metrics = extractMetrics(mobile, 'mobile');

  // Recorded values: 3046.36, 5475.5 and 5322.97 ms.
  assert.equal(metrics.fcpMs, 3046);
  assert.equal(metrics.lcpMs, 5476);
  assert.equal(metrics.speedIndexMs, 5323);
  assert.equal(metrics.sources.lcp, 'lab');
});

test('keeps CLS unitless at three decimals rather than rounding it away', () => {
  // The recorded shop has a perfect CLS of 0, so the rounding is exercised on a
  // copy: a whole-number rounding would report 0 for a genuinely janky page.
  const response = structuredClone(mobile);
  response.lighthouseResult!.audits!['cumulative-layout-shift']!.numericValue = 0.1284;

  assert.equal(extractMetrics(response, 'mobile').cls, 0.128);
  assert.equal(extractMetrics(mobile, 'mobile').cls, 0);
});

test('prefers the field TTFB over the lab audit', () => {
  const metrics = extractMetrics(mobile, 'mobile');

  // Lighthouse reported 4 ms — "Root document took 0 ms" — from Google's
  // datacenter to a Shopify CDN edge. Real Chrome users waited 667 ms.
  assert.equal(metrics.ttfbMs, 667);
  assert.equal(metrics.sources.ttfb, 'field');
});

test('falls back to the lab TTFB when CrUX has no sample', () => {
  const response = structuredClone(mobile);
  delete response.loadingExperience;
  delete response.originLoadingExperience;

  const metrics = extractMetrics(response, 'mobile');

  assert.equal(metrics.ttfbMs, 4);
  assert.equal(metrics.sources.ttfb, 'lab');
});

test('takes INP from field data — Lighthouse cannot measure it', () => {
  const metrics = extractMetrics(mobile, 'mobile');

  // URL-level (70) wins over origin-level (103).
  assert.equal(metrics.inpMs, 70);
  assert.equal(metrics.sources.inp, 'field');
});

test('uses origin field data when the URL itself has no CrUX sample', () => {
  const response = structuredClone(mobile);
  delete response.loadingExperience;

  const metrics = extractMetrics(response, 'mobile');

  assert.equal(metrics.inpMs, 103);
  assert.equal(metrics.hasFieldData, true);
});

test('leaves INP null for a store CrUX has never seen', () => {
  const response = structuredClone(mobile);
  delete response.loadingExperience;
  delete response.originLoadingExperience;

  const metrics = extractMetrics(response, 'mobile');

  assert.equal(metrics.inpMs, null);
  assert.equal(metrics.sources.inp, undefined);
  assert.equal(metrics.hasFieldData, false);
  // Lab metrics are unaffected by missing field data.
  assert.equal(metrics.lcpMs, 5476);
});

test('reports a runtime error instead of zeroed metrics', () => {
  const metrics = extractMetrics(fixture('run-failed'), 'desktop');

  assert.equal(metrics.runtimeError?.code, 'ERRORED_DOCUMENT_REQUEST');
  assert.match(metrics.runtimeError?.message ?? '', /unable to reliably load/i);
  assert.equal(metrics.scores.performance, null);
  // The audits are present but carry scoreDisplayMode 'error' and no value.
  assert.equal(metrics.fcpMs, null);
  assert.equal(metrics.lcpMs, null);
});

test('treats a NO_ERROR runtimeError as no error', () => {
  const response = structuredClone(mobile);
  response.lighthouseResult!.runtimeError = { code: 'NO_ERROR' };

  assert.equal(extractMetrics(response, 'mobile').runtimeError, null);
});

test('keeps an unscored category null rather than scoring it zero', () => {
  const response = structuredClone(mobile);
  response.lighthouseResult!.categories!['seo'] = { id: 'seo', score: null };

  const metrics = extractMetrics(response, 'mobile');

  assert.equal(metrics.scores.seo, null);
  assert.equal(metrics.scores.performance, 70);
});

test('records a genuine zero score as 0', () => {
  const response = structuredClone(mobile);
  response.lighthouseResult!.categories!['performance'] = { id: 'performance', score: 0 };

  assert.equal(extractMetrics(response, 'mobile').scores.performance, 0);
});

test('carries the final URL, fetch time, version and strategy', () => {
  const metrics = extractMetrics(mobile, 'mobile');

  assert.equal(metrics.strategy, 'mobile');
  assert.equal(metrics.url, 'https://keyshorts.com/');
  assert.equal(metrics.fetchedAt, '2026-09-01T12:57:12.132Z');
  assert.equal(metrics.lighthouseVersion, '13.4.1');
});

test('survives a response with no lighthouseResult at all', () => {
  const metrics = extractMetrics({ id: 'https://x.pl/' }, 'desktop');

  assert.deepEqual(metrics.scores, {
    performance: null,
    accessibility: null,
    bestPractices: null,
    seo: null,
  });
  assert.equal(metrics.url, 'https://x.pl/');
  assert.deepEqual(metrics.sources, {});
});
