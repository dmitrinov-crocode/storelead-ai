import type { StepLogRow } from '../db/types.js';
import { STEP_ORDER } from './status.js';

/**
 * The run report of task 7-04.
 *
 * `pipeline status` already prints every step log, which is the right tool when
 * one store misbehaved and the wrong one for the question this answers: how did
 * the batch go, and what did it cost. Forty stores across six steps is two
 * hundred and forty lines, and nobody reads them looking for a total.
 *
 * Built as a pure function over the rows so it can be tested without a run, and
 * so the same numbers can feed the dashboard later without going through stdout.
 *
 * ## Where the token counts come from
 *
 * Every step that calls a model writes its usage into `meta_json`, but not in
 * one shape — the analysis step ran two agents and records an array, the contact
 * search records a search and its own totals, the outreach step records the
 * writer and the reviewer separately. Rather than force one schema on three
 * different jobs, the reader knows all three. A step whose shape is unknown
 * simply contributes nothing, which is why the totals are a floor and not a
 * guess: what is counted was really spent.
 */

export interface StepSummary {
  /** A `StepName` in practice, typed loosely so an old log row still reports. */
  step: string;
  ok: number;
  failed: number;
  skipped: number;
  /** Wall time across every store, which exceeds the run's own clock when concurrent. */
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Store ids that failed, so the next command can be typed rather than composed. */
  failedStores: number[];
  /** One error per distinct message, with how often it happened. */
  errors: { message: string; count: number }[];
}

export interface RunSummary {
  runId: number;
  steps: StepSummary[];
  totals: { ok: number; failed: number; skipped: number; tokensIn: number; tokensOut: number };
  /** Stores that failed at any step at all. */
  storesFailed: number[];
  /** Stores that reached the last step without failing. */
  storesCompleted: number[];
}

interface Usage {
  tokensIn: number;
  tokensOut: number;
}

/** A number, or zero when the field is missing or not one. */
function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Tokens one step log accounts for.
 *
 * Exported because the shapes are the fiddly part: a change to a step's meta
 * that silently stops being counted would make the bill look smaller.
 */
export function usageOf(meta: unknown): Usage {
  if (typeof meta !== 'object' || meta === null) return { tokensIn: 0, tokensOut: 0 };
  const row = meta as Record<string, unknown>;

  // ai_analysis: one entry per agent.
  if (Array.isArray(row['usage'])) {
    let tokensIn = 0;
    let tokensOut = 0;
    for (const entry of row['usage']) {
      if (typeof entry !== 'object' || entry === null) continue;
      const agent = entry as Record<string, unknown>;
      tokensIn += n(agent['tokensIn']);
      tokensOut += n(agent['tokensOut']);
    }
    return { tokensIn, tokensOut };
  }

  return {
    // email_generation: the writer, plus the reviewer under its own key.
    tokensIn: n(row['tokensIn']) + n(row['qcTokensIn']) + n(row['searchTokensIn']),
    tokensOut: n(row['tokensOut']) + n(row['qcTokensOut']) + n(row['searchTokensOut']),
  };
}

function parseMeta(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Steps in pipeline order; anything unknown sorts after, in the order it appeared. */
function stepRank(step: string): number {
  const index = (STEP_ORDER as readonly string[]).indexOf(step);
  return index === -1 ? STEP_ORDER.length : index;
}

/**
 * Aggregates one run's step logs.
 *
 * Only the last attempt of a step counts towards ok/failed: a retry that
 * eventually succeeded is a success, and counting both would make the retry
 * ladder look like a failure rate.
 */
export function summariseRun(runId: number, logs: readonly StepLogRow[]): RunSummary {
  const latest = new Map<string, StepLogRow>();
  for (const log of logs) {
    if (log.status === 'RUNNING') continue;
    const key = `${log.step}:${log.store_id ?? 'run'}`;
    const previous = latest.get(key);
    if (!previous || log.attempt >= previous.attempt) latest.set(key, log);
  }

  const byStep = new Map<string, StepSummary>();
  const failedStores = new Set<number>();
  const seenStores = new Set<number>();

  for (const log of latest.values()) {
    const summary = byStep.get(log.step) ?? {
      step: log.step,
      ok: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      failedStores: [],
      errors: [],
    };

    if (log.status === 'OK') summary.ok += 1;
    else if (log.status === 'FAILED') summary.failed += 1;
    else summary.skipped += 1;

    summary.durationMs += log.duration_ms ?? 0;

    const usage = usageOf(parseMeta(log.meta_json));
    summary.tokensIn += usage.tokensIn;
    summary.tokensOut += usage.tokensOut;

    if (log.store_id !== null) {
      seenStores.add(log.store_id);
      if (log.status === 'FAILED') {
        summary.failedStores.push(log.store_id);
        failedStores.add(log.store_id);
      }
    }

    if (log.status === 'FAILED' && log.error) {
      const existing = summary.errors.find((row) => row.message === log.error);
      if (existing) existing.count += 1;
      else summary.errors.push({ message: log.error, count: 1 });
    }

    byStep.set(log.step, summary);
  }

  const steps = [...byStep.values()].sort((a, b) => stepRank(a.step) - stepRank(b.step));
  for (const step of steps) step.failedStores.sort((a, b) => a - b);

  return {
    runId,
    steps,
    totals: steps.reduce(
      (acc, step) => ({
        ok: acc.ok + step.ok,
        failed: acc.failed + step.failed,
        skipped: acc.skipped + step.skipped,
        tokensIn: acc.tokensIn + step.tokensIn,
        tokensOut: acc.tokensOut + step.tokensOut,
      }),
      { ok: 0, failed: 0, skipped: 0, tokensIn: 0, tokensOut: 0 },
    ),
    storesFailed: [...failedStores].sort((a, b) => a - b),
    storesCompleted: [...seenStores].filter((id) => !failedStores.has(id)).sort((a, b) => a - b),
  };
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function thousands(value: number): string {
  return value.toLocaleString('en-US');
}

/** The report as a person reads it. */
export function formatRunReport(summary: RunSummary): string {
  const lines: string[] = [
    `Run #${summary.runId}`,
    '',
    `  ${'step'.padEnd(18)} ${'ok'.padStart(4)} ${'fail'.padStart(5)} ${'skip'.padStart(5)} ${'time'.padStart(9)} ${'tokens in'.padStart(11)} ${'out'.padStart(9)}`,
  ];

  for (const step of summary.steps) {
    lines.push(
      `  ${step.step.padEnd(18)} ${String(step.ok).padStart(4)} ${String(step.failed).padStart(5)} ` +
        `${String(step.skipped).padStart(5)} ${seconds(step.durationMs).padStart(9)} ` +
        `${thousands(step.tokensIn).padStart(11)} ${thousands(step.tokensOut).padStart(9)}`,
    );
  }

  const { totals } = summary;
  lines.push(
    '',
    `  ${'total'.padEnd(18)} ${String(totals.ok).padStart(4)} ${String(totals.failed).padStart(5)} ` +
      `${String(totals.skipped).padStart(5)} ${''.padStart(9)} ` +
      `${thousands(totals.tokensIn).padStart(11)} ${thousands(totals.tokensOut).padStart(9)}`,
    '',
    `  stores through every step: ${summary.storesCompleted.length}` +
      (summary.storesFailed.length > 0 ? `, failed somewhere: ${summary.storesFailed.length}` : ''),
  );

  const withErrors = summary.steps.filter((step) => step.errors.length > 0);
  if (withErrors.length > 0) {
    lines.push('', '  where it went wrong:');
    for (const step of withErrors) {
      for (const error of step.errors) {
        lines.push(
          `    ${step.step}: ${error.message}${error.count > 1 ? ` (×${error.count})` : ''}`,
        );
      }
      if (step.failedStores.length > 0) {
        lines.push(`      stores ${step.failedStores.join(', ')}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}
