/**
 * IMPORTANT: this module must not import anything by relative path.
 *
 * The dashboard imports it to guard the Approve and Skip buttons of 6-08, and
 * Turbopack cannot map a `.js` specifier onto a `.ts` file — a single relative
 * import here breaks `next build` with "Cannot find module '../client.js'".
 * Type-only imports are erased before bundling and are therefore fine.
 *
 * ## Why the rule lives on its own
 *
 * There are two writers to the `emails` table now: the pipeline, which drafts,
 * and the dashboard, which records what a human decided. The rule that says
 * which move is legal must exist once. Approving a letter that never passed QC
 * is the single mistake in this flow that puts an unchecked claim in front of a
 * merchant, and a dashboard button is exactly where that misclick happens — so
 * the check cannot be a copy that drifts from the original.
 *
 *     DRAFT ──▶ QC_FAILED ──▶ (regenerated as a new version)
 *       │
 *       └────▶ READY ──▶ APPROVED
 *                   └──▶ SKIPPED
 */
import type { EmailStatus } from './status.js';

/** What a human may decide, and the states they may decide it from. */
export const HUMAN_TRANSITIONS: Readonly<Record<HumanDecision, readonly EmailStatus[]>> = {
  APPROVED: ['READY'],
  SKIPPED: ['DRAFT', 'QC_FAILED', 'READY'],
};

export type HumanDecision = 'APPROVED' | 'SKIPPED';

/** Statuses a newly written version is allowed to supersede. */
export const SUPERSEDABLE: readonly EmailStatus[] = ['DRAFT', 'QC_FAILED', 'READY'];

export function isHumanDecision(value: unknown): value is HumanDecision {
  return value === 'APPROVED' || value === 'SKIPPED';
}

export function canTransition(from: EmailStatus, to: HumanDecision): boolean {
  return HUMAN_TRANSITIONS[to].includes(from);
}

/** Raised when a transition is not one the status machine allows. */
export class EmailTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`an email cannot go from ${from} to ${to}`);
    this.name = 'EmailTransitionError';
  }
}
