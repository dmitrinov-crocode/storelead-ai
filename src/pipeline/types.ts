import type { Database } from '../db/client.js';
import type { StoreRow } from '../db/types.js';
import type { Logger } from '../lib/logger.js';
import type { StepName } from './status.js';

export interface StepContext {
  runId: number;
  /** Present only for store-scoped steps. */
  store: StoreRow | null;
  db: Database | undefined;
  logger: Logger;
  /** Re-run the step even if its result is already present (task 0-10). */
  force: boolean;
  /** Aborted when the step exceeds its timeout. */
  signal: AbortSignal;
}

/** `isSatisfied` is a synchronous database check — it gets no abort signal. */
export type SatisfiedContext = Omit<StepContext, 'signal'>;

export interface StepOutcome {
  status: 'OK' | 'SKIPPED';
  meta?: unknown;
}

export interface PipelineStep {
  name: StepName;
  /** 'run' steps execute once per run; 'store' steps execute per active store. */
  scope: 'run' | 'store';
  /**
   * True when the step's result already exists, so it can be skipped on a
   * resumed run. Omit for steps that are cheap or always meant to re-run.
   */
  isSatisfied?: (ctx: SatisfiedContext) => boolean;
  attempts?: number;
  /** Base backoff between attempts; lowered in tests to keep them fast. */
  retryBaseDelayMs?: number;
  timeoutMs?: number;
  /**
   * When true, a failure marks the store FAILED but lets the run continue.
   * Run-scoped steps default to false — if no stores are fetched there is nothing to do.
   */
  softFail?: boolean;
  run: (ctx: StepContext) => Promise<StepOutcome>;
  /**
   * Released once, after the step has run for every store. Steps holding a
   * process-level resource (the audit's browser) would otherwise keep the CLI
   * alive after the pipeline finished.
   */
  teardown?: () => Promise<void>;
}
