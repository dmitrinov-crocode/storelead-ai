import { getConfig } from '../config/index.js';
import type { Database } from '../db/client.js';
import { finishStep, lastStepLog, startStep } from '../db/repositories/stepLogs.js';
import { createRun, getRun, markAbandonedRuns, setRunStatus } from '../db/repositories/runs.js';
import { listActiveStores, setStoreStatus } from '../db/repositories/stores.js';
import type { StoreRow } from '../db/types.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { normalizeDomain } from '../lib/domain.js';
import { childLogger, logger as rootLogger, type Logger } from '../lib/logger.js';
import { clearLock, writeLock } from '../lib/pipelineLock.js';
import { elapsedMs } from '../lib/time.js';
import { StepError, withRetry, withTimeout } from './retry.js';
import { STEP_ORDER, type StepName } from './status.js';
import type { PipelineStep, StepOutcome } from './types.js';

export interface RunOptions {
  /** Resume an existing run instead of creating one. */
  runId?: number;
  /** Restrict execution to these steps. */
  only?: StepName[];
  /** Ignore `isSatisfied` and re-run work that is already done. */
  force?: boolean;
  /**
   * Restrict store-scoped steps to these domains.
   *
   * Added for the dashboard's Regenerate button (task 6-08): redoing one letter
   * must not redo the batch. A domain that is not in the run is reported rather
   * than silently doing nothing, because "nothing happened" and "that shop is
   * not in this run" look identical from the UI.
   */
  domains?: string[];
  batchSize?: number;
  country?: string;
  concurrency?: number;
  db?: Database;
}

export interface StepReport {
  step: StepName;
  ok: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface RunReport {
  runId: number;
  status: 'COMPLETED' | 'FAILED';
  steps: StepReport[];
  durationMs: number;
  error?: string;
}

function orderSteps(steps: PipelineStep[], only?: StepName[]): PipelineStep[] {
  const wanted = only ? new Set(only) : null;
  return [...steps]
    .filter((s) => !wanted || wanted.has(s.name))
    .sort((a, b) => STEP_ORDER.indexOf(a.name) - STEP_ORDER.indexOf(b.name));
}

/** Executes one step for one target, handling skip / retry / timeout / logging. */
async function executeStep(
  step: PipelineStep,
  runId: number,
  store: StoreRow | null,
  options: { force: boolean; db: Database | undefined; log: Logger },
): Promise<'OK' | 'SKIPPED' | 'FAILED'> {
  const { force, db, log } = options;
  const stepLog = childLogger(
    { step: step.name, ...(store ? { store_id: store.id, domain: store.domain } : {}) },
    log,
  );

  const baseCtx = {
    runId,
    store,
    db,
    logger: stepLog,
    force,
  };

  // Idempotency: skip work whose result is already in the database (task 0-10).
  if (!force && step.isSatisfied) {
    const satisfied = step.isSatisfied(baseCtx);
    if (satisfied) {
      stepLog.debug('step already satisfied, skipping');
      const id = startStep({ runId, storeId: store?.id ?? null, step: step.name }, 0, db);
      finishStep(id, 'SKIPPED', { durationMs: 0, meta: { reason: 'already_satisfied' } }, db);
      return 'SKIPPED';
    }
  }

  const attempts = step.attempts ?? 3;
  const timeoutMs = step.timeoutMs ?? 120_000;
  const startedAt = performance.now();
  let logId = 0;

  try {
    const outcome = await withRetry<StepOutcome>(
      async (attempt) => {
        logId = startStep({ runId, storeId: store?.id ?? null, step: step.name }, attempt, db);
        try {
          return await withTimeout(
            (signal) => step.run({ ...baseCtx, signal }),
            timeoutMs,
            `${step.name}${store ? ` (${store.domain})` : ''}`,
          );
        } catch (error) {
          finishStep(
            logId,
            'FAILED',
            { durationMs: elapsedMs(startedAt), error: (error as Error).message },
            db,
          );
          throw error;
        }
      },
      {
        attempts,
        baseDelayMs: step.retryBaseDelayMs ?? 1000,
        onRetry: (error, attempt, delay) =>
          stepLog.warn(
            { attempt, delay_ms: delay, err: (error as Error).message },
            'step failed, retrying',
          ),
      },
    );

    finishStep(
      logId,
      outcome.status,
      {
        durationMs: elapsedMs(startedAt),
        ...(outcome.meta === undefined ? {} : { meta: outcome.meta }),
      },
      db,
    );
    stepLog.info({ duration_ms: elapsedMs(startedAt) }, `step ${outcome.status.toLowerCase()}`);
    return outcome.status;
  } catch (error) {
    const message = (error as Error).message;
    stepLog.error({ err: message }, 'step failed');

    if (store && (step.softFail ?? true)) {
      // Keep the run going; the store is retried by a later `--force` or resume.
      setStoreStatus(store.id, 'FAILED', `${step.name}: ${message}`, db);
      return 'FAILED';
    }
    throw error instanceof StepError ? error : new StepError(message, { cause: error });
  }
}

/**
 * Runs the pipeline (task 0-09). A run is resumable: passing `runId` picks up
 * the stores already attached to it and skips steps whose results exist.
 */
export async function runPipeline(
  steps: PipelineStep[],
  options: RunOptions = {},
): Promise<RunReport> {
  const config = getConfig();
  const db = options.db;
  const log = rootLogger();
  const startedAt = performance.now();

  const country = options.country ?? config.pipeline.targetCountry;
  const batchSize = options.batchSize ?? config.pipeline.batchSize;
  const concurrency = options.concurrency ?? config.pipeline.storeConcurrency;

  const run = options.runId ? getRun(options.runId, db) : createRun(country, batchSize, db);
  if (!run) throw new Error(`Run ${options.runId} not found`);

  // Clean up after a previous run that was killed before it could finish.
  const abandoned = markAbandonedRuns(run.id, db);
  if (abandoned > 0) log.warn({ abandoned }, 'marked abandoned runs as failed');

  // Claim the lock so the dashboard knows a run is in progress, whoever started it.
  writeLock(config.paths.data, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    label: `Run #${run.id}`,
  });

  const runLog = childLogger({ run_id: run.id }, log);
  if (run.status === 'PENDING') setRunStatus(run.id, 'RUNNING', {}, db);

  const ordered = orderSteps(steps, options.only);
  const reports: StepReport[] = [];
  runLog.info(
    {
      steps: ordered.map((s) => s.name),
      country,
      batch_size: batchSize,
      resumed: Boolean(options.runId),
    },
    'pipeline started',
  );

  try {
    for (const step of ordered) {
      const stepStart = performance.now();
      const report: StepReport = { step: step.name, ok: 0, failed: 0, skipped: 0, durationMs: 0 };

      if (step.scope === 'run') {
        const result = await executeStep(step, run.id, null, {
          force: options.force ?? false,
          db,
          log: runLog,
        });
        report[result === 'OK' ? 'ok' : result === 'SKIPPED' ? 'skipped' : 'failed'] += 1;
      } else {
        const stores = selectStores(listActiveStores(run.id, db), options.domains, runLog);
        if (stores.length === 0) runLog.warn({ step: step.name }, 'no active stores for step');

        const results = await mapWithConcurrency(stores, concurrency, (store) =>
          executeStep(step, run.id, store, { force: options.force ?? false, db, log: runLog }),
        );
        for (const result of results) {
          report[result === 'OK' ? 'ok' : result === 'SKIPPED' ? 'skipped' : 'failed'] += 1;
        }
      }

      try {
        await step.teardown?.();
      } catch (error) {
        runLog.warn({ step: step.name, err: (error as Error).message }, 'step teardown failed');
      }

      report.durationMs = elapsedMs(stepStart);
      reports.push(report);
      runLog.info({ ...report }, 'step finished');
    }

    setRunStatus(run.id, 'COMPLETED', {}, db);
    clearLock(config.paths.data);
    const durationMs = elapsedMs(startedAt);
    runLog.info({ duration_ms: durationMs }, 'pipeline completed');
    return { runId: run.id, status: 'COMPLETED', steps: reports, durationMs };
  } catch (error) {
    const message = (error as Error).message;
    setRunStatus(run.id, 'FAILED', { error: message }, db);
    clearLock(config.paths.data);
    runLog.error({ err: message }, 'pipeline failed');
    return {
      runId: run.id,
      status: 'FAILED',
      steps: reports,
      durationMs: elapsedMs(startedAt),
      error: message,
    };
  }
}

/** True when a store already completed the given step successfully (task 0-10). */
export function stepCompleted(step: StepName, storeId: number | null, db?: Database): boolean {
  const last = lastStepLog({ runId: 0, storeId, step }, db);
  return last?.status === 'OK';
}

/**
 * The stores a run should touch, narrowed to `--store` when it was given.
 *
 * Domains are matched after normalisation, so `https://sklep.pl/` from a copied
 * address bar finds the same row as `sklep.pl`.
 */
function selectStores(stores: StoreRow[], domains: string[] | undefined, log: Logger): StoreRow[] {
  if (!domains || domains.length === 0) return stores;

  const wanted = new Set(
    domains.map((domain) => normalizeDomain(domain)?.domain ?? domain.trim().toLowerCase()),
  );
  const selected = stores.filter((store) => wanted.has(store.domain));

  for (const domain of wanted) {
    if (!selected.some((store) => store.domain === domain)) {
      log.warn({ domain }, 'store is not active in this run; skipping it');
    }
  }
  return selected;
}
