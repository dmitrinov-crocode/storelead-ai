import { CATEGORIES } from './types.js';
import type {
  LighthouseAudit,
  LoadingExperience,
  PagespeedResponse,
  PagespeedStrategy,
} from './types.js';

/**
 * Turns a PageSpeed Insights response into the columns of `pagespeed_results`
 * (task 2-19).
 *
 * PSI answers with two different kinds of number and they must not be blended
 * carelessly:
 *
 *   - **lab** (`lighthouseResult`) — one synthetic load from Google's machine.
 *     Always present, identical methodology for every store, so it is what makes
 *     two stores comparable.
 *   - **field** (`loadingExperience`) — the 75th percentile of what real Chrome
 *     users saw over the last 28 days. Truthful, but absent for any origin
 *     without enough traffic, which is most of the segment we prospect in.
 *
 * Lab wins for FCP, LCP, CLS and Speed Index: those come from one throttled
 * simulation, so two stores can be compared. Two metrics break that rule:
 *
 *   - **INP** has no lab equivalent — Lighthouse cannot interact with the page —
 *     so it is field-only and stays null for a store CrUX has never seen.
 *   - **TTFB** is field-first, because the lab figure is raw network time from
 *     Google's datacenter to a CDN edge and describes nobody's experience.
 *
 * `sources` records which origin each number came from, because "no INP" and
 * "INP is fine" are very different facts and the number alone cannot tell them
 * apart.
 */

export interface PagespeedScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

export type MetricSource = 'lab' | 'field';

export interface PagespeedMetrics {
  strategy: PagespeedStrategy;
  /** The URL Lighthouse ended on — redirects mean this may differ from the request. */
  url: string | null;
  fetchedAt: string | null;
  lighthouseVersion: string | null;
  scores: PagespeedScores;
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  speedIndexMs: number | null;
  /** Where each metric above came from; absent key = the metric is null. */
  sources: Partial<Record<'fcp' | 'lcp' | 'cls' | 'inp' | 'ttfb' | 'speedIndex', MetricSource>>;
  /** True when CrUX had a sample for this URL or its origin. */
  hasFieldData: boolean;
  /**
   * Set when the analysis itself failed (DNS_FAILURE, ERRORED_DOCUMENT_REQUEST,
   * NO_FCP…). PSI still answers 200 in that case, with the scores missing.
   */
  runtimeError: { code: string; message: string | null } | null;
}

/** Lighthouse scores are 0..1; the schema and every report speak 0..100. */
function toScore(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * `numericValue` is missing on audits Lighthouse could not run, and such audits
 * carry `scoreDisplayMode: 'error'` — reading them would record a 0 ms LCP.
 */
function auditMs(audit: LighthouseAudit | undefined): number | null {
  if (!audit || audit.scoreDisplayMode === 'error') return null;
  const value = audit.numericValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function auditNumber(audit: LighthouseAudit | undefined): number | null {
  if (!audit || audit.scoreDisplayMode === 'error') return null;
  const value = audit.numericValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  // CLS is unitless and small; three decimals is the precision Lighthouse reports.
  return Math.round(value * 1000) / 1000;
}

function fieldPercentile(experience: LoadingExperience | undefined, metric: string): number | null {
  const value = experience?.metrics?.[metric]?.percentile;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** URL-level field data is more specific; origin-level is the fallback. */
function pickField(
  response: PagespeedResponse,
  metric: string,
): { value: number; source: MetricSource } | null {
  const url = fieldPercentile(response.loadingExperience, metric);
  if (url !== null) return { value: url, source: 'field' };
  const origin = fieldPercentile(response.originLoadingExperience, metric);
  if (origin !== null) return { value: origin, source: 'field' };
  return null;
}

export function extractMetrics(
  response: PagespeedResponse,
  strategy: PagespeedStrategy,
): PagespeedMetrics {
  const lh = response.lighthouseResult;
  const audits = lh?.audits;
  const categories = lh?.categories;
  const sources: PagespeedMetrics['sources'] = {};

  const lab = (id: string) => audits?.[id];

  const fcpMs = auditMs(lab('first-contentful-paint'));
  const lcpMs = auditMs(lab('largest-contentful-paint'));
  const cls = auditNumber(lab('cumulative-layout-shift'));
  const speedIndexMs = auditMs(lab('speed-index'));
  // Lighthouse's TTFB audit; the field equivalent is EXPERIMENTAL_TIME_TO_FIRST_BYTE.
  const ttfbLabMs = auditMs(lab('server-response-time'));

  if (fcpMs !== null) sources.fcp = 'lab';
  if (lcpMs !== null) sources.lcp = 'lab';
  if (cls !== null) sources.cls = 'lab';
  if (speedIndexMs !== null) sources.speedIndex = 'lab';

  // TTFB is the one metric where lab loses. The other lab numbers come from a
  // throttled simulation, which makes them comparable between stores; TTFB is
  // raw network time from Google's datacenter to a CDN edge. On keyshorts.com
  // (measured 2026-09-01) Lighthouse reported 4 ms — "Root document took 0 ms" —
  // while real Chrome users waited 667 ms. Field first, lab only as a fallback.
  let ttfbMs: number | null = null;
  const ttfbField = pickField(response, 'EXPERIMENTAL_TIME_TO_FIRST_BYTE');
  if (ttfbField) {
    ttfbMs = Math.round(ttfbField.value);
    sources.ttfb = ttfbField.source;
  } else if (ttfbLabMs !== null) {
    ttfbMs = ttfbLabMs;
    sources.ttfb = 'lab';
  }

  // Field-only: Lighthouse has no INP audit, it cannot interact with the page.
  let inpMs: number | null = null;
  const inpField = pickField(response, 'INTERACTION_TO_NEXT_PAINT');
  if (inpField) {
    inpMs = Math.round(inpField.value);
    sources.inp = inpField.source;
  }

  const runtimeErrorCode = lh?.runtimeError?.code;
  const runtimeError =
    runtimeErrorCode && runtimeErrorCode !== 'NO_ERROR'
      ? { code: runtimeErrorCode, message: lh?.runtimeError?.message ?? null }
      : null;

  const [performance, accessibility, bestPractices, seo] = CATEGORIES.map((id) =>
    toScore(categories?.[id]?.score),
  );

  return {
    strategy,
    url: lh?.finalDisplayedUrl ?? lh?.finalUrl ?? lh?.requestedUrl ?? response.id ?? null,
    fetchedAt: lh?.fetchTime ?? response.analysisUTCTimestamp ?? null,
    lighthouseVersion: lh?.lighthouseVersion ?? null,
    scores: {
      performance: performance ?? null,
      accessibility: accessibility ?? null,
      bestPractices: bestPractices ?? null,
      seo: seo ?? null,
    },
    fcpMs,
    lcpMs,
    cls,
    inpMs,
    ttfbMs,
    speedIndexMs,
    sources,
    hasFieldData: Boolean(response.loadingExperience ?? response.originLoadingExperience),
    runtimeError,
  };
}
