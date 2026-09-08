/**
 * Builds the argv for a pipeline command started from the UI.
 *
 * Kept free of Next imports so it can be unit-tested by the root test suite,
 * and separate from the action that spawns it: everything that decides *what*
 * runs is here, so nothing user-supplied ever reaches a shell.
 */

export const PIPELINE_ACTIONS = ['run', 'seed'] as const;
export type PipelineAction = (typeof PIPELINE_ACTIONS)[number];

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 100;
export const LIMIT_CHOICES = [5, 10, 25, 50] as const;

export class InvalidCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCommandError';
  }
}

export function parseAction(value: unknown): PipelineAction {
  if (typeof value === 'string' && (PIPELINE_ACTIONS as readonly string[]).includes(value)) {
    return value as PipelineAction;
  }
  throw new InvalidCommandError(`Unknown action: ${String(value)}`);
}

/** The batch size must be a whole number in range — it becomes a CLI argument. */
export function parseLimit(value: unknown): number {
  let raw: number;
  if (typeof value === 'number') {
    raw = value;
  } else {
    // Number('') is 0, so an empty or missing field must be rejected before coercion.
    const text = String(value ?? '').trim();
    if (text === '') {
      throw new InvalidCommandError(`Limit must be a whole number, got: ${String(value)}`);
    }
    raw = Number(text);
  }
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new InvalidCommandError(`Limit must be a whole number, got: ${String(value)}`);
  }
  if (raw < MIN_LIMIT || raw > MAX_LIMIT) {
    throw new InvalidCommandError(`Limit must be between ${MIN_LIMIT} and ${MAX_LIMIT}, got ${raw}`);
  }
  return raw;
}

export interface PipelineCommand {
  /** Arguments after the tsx entrypoint — never passed through a shell. */
  args: string[];
  /** Short description shown in the UI and written to the log header. */
  label: string;
}

export function buildPipelineCommand(action: PipelineAction, limit?: unknown): PipelineCommand {
  if (action === 'seed') {
    return { args: ['db', 'seed'], label: 'Seeding demo data' };
  }
  const parsed = parseLimit(limit);
  return {
    args: ['run', '--limit', String(parsed)],
    label: `Fetching ${parsed} store${parsed === 1 ? '' : 's'}`,
  };
}

/** Log file name for one UI-triggered command; unique per invocation. */
export function logFileName(action: PipelineAction, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `ui-${action}-${stamp}.log`;
}
