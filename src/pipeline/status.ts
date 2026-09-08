/**
 * Status machines for the pipeline (task 0-08).
 * Transitions are declared as data so illegal moves fail loudly instead of
 * leaving a store in a state no step knows how to resume from.
 */

export const RUN_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STORE_STATUSES = [
  'NEW', // fetched from StoreLeads, nothing done yet
  'AUDITED', // Playwright + PageSpeed + theme/apps facts collected
  'ANALYZED', // AI classification and lead score present
  'CONTACTED', // contact search finished (may have found only a generic email)
  'EMAIL_READY', // an email passed QC and awaits human review
  'APPROVED', // human approved the email
  'SKIPPED', // deliberately excluded from outreach
  'DUPLICATE', // already present under the same normalised domain
  'FAILED', // a step failed hard; retryable
] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export const AUDIT_STATUSES = ['PENDING', 'RUNNING', 'OK', 'PARTIAL', 'BLOCKED', 'FAILED'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const EMAIL_STATUSES = ['DRAFT', 'QC_FAILED', 'READY', 'APPROVED', 'SKIPPED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const STEP_STATUSES = ['RUNNING', 'OK', 'FAILED', 'SKIPPED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export const RUN_TRANSITIONS: TransitionMap<RunStatus> = {
  PENDING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const STORE_TRANSITIONS: TransitionMap<StoreStatus> = {
  NEW: ['AUDITED', 'SKIPPED', 'DUPLICATE', 'FAILED'],
  AUDITED: ['ANALYZED', 'SKIPPED', 'FAILED'],
  ANALYZED: ['CONTACTED', 'SKIPPED', 'FAILED'],
  CONTACTED: ['EMAIL_READY', 'SKIPPED', 'FAILED'],
  EMAIL_READY: ['APPROVED', 'SKIPPED', 'FAILED'],
  APPROVED: [],
  SKIPPED: [],
  DUPLICATE: [],
  // A failed store re-enters the pipeline at the step that failed.
  FAILED: ['NEW', 'AUDITED', 'ANALYZED', 'CONTACTED', 'EMAIL_READY', 'SKIPPED'],
};

export const AUDIT_TRANSITIONS: TransitionMap<AuditStatus> = {
  PENDING: ['RUNNING', 'FAILED'],
  RUNNING: ['OK', 'PARTIAL', 'BLOCKED', 'FAILED'],
  OK: ['RUNNING'],
  PARTIAL: ['RUNNING'],
  BLOCKED: ['RUNNING'],
  FAILED: ['RUNNING'],
};

export const EMAIL_TRANSITIONS: TransitionMap<EmailStatus> = {
  DRAFT: ['READY', 'QC_FAILED', 'SKIPPED'],
  QC_FAILED: ['DRAFT', 'SKIPPED'],
  READY: ['APPROVED', 'SKIPPED', 'DRAFT'],
  APPROVED: [],
  SKIPPED: ['DRAFT'],
};

/** Store statuses from which no further pipeline work is attempted. */
export const TERMINAL_STORE_STATUSES: readonly StoreStatus[] = ['APPROVED', 'SKIPPED', 'DUPLICATE'];

export function canTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): boolean {
  return from === to || (map[from]?.includes(to) ?? false);
}

export function assertTransition<S extends string>(
  map: TransitionMap<S>,
  from: S,
  to: S,
  entity: string,
): void {
  if (!canTransition(map, from, to)) {
    throw new Error(
      `Illegal ${entity} transition: ${from} -> ${to}. Allowed: ${map[from]?.join(', ') || 'none'}`,
    );
  }
}

/** Pipeline step order, used to decide what a store still needs (task 0-10). */
export const STEP_ORDER = [
  'fetch_stores',
  'audit',
  'pagespeed',
  'theme_apps',
  'ai_analysis',
  'contact_search',
  'email_generation',
] as const;
export type StepName = (typeof STEP_ORDER)[number];
