import type { EmailStatus, RunStatus, StoreStatus } from "@core/pipeline/status";
import type { IssueSeverity } from "@core/db/types";

/**
 * Presentation for every status the pipeline can produce: a colour and a short
 * description. Descriptions mirror the state machines in `src/pipeline/status.ts`
 * — if a transition changes there, update the wording here too.
 *
 * Colours read as a progression through the pipeline (neutral -> cool -> warm ->
 * green when done), with red reserved for failure and grey for deliberate exits.
 * Every class pair is set for both themes so the palette survives a dark toggle.
 */

export interface StatusMeta {
  description: string;
  className: string;
}

const NEUTRAL = "bg-slate-500/10 text-slate-700 dark:text-slate-300";
const COOL = "bg-sky-500/10 text-sky-700 dark:text-sky-300";
const DEEP = "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300";
const VIOLET = "bg-violet-500/10 text-violet-700 dark:text-violet-300";
const ATTENTION = "bg-amber-500/15 text-amber-700 dark:text-amber-300";
const DONE = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
const MUTED = "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400";
const BAD = "bg-red-500/10 text-red-700 dark:text-red-300";
const ACTIVE = "bg-blue-500/15 text-blue-700 dark:text-blue-300";

export const STORE_STATUS_META: Record<StoreStatus, StatusMeta> = {
  NEW: { description: "Fetched from StoreLeads, no work done yet", className: NEUTRAL },
  AUDITED: { description: "Playwright, PageSpeed, theme and apps collected", className: COOL },
  ANALYZED: { description: "AI category and lead score assigned", className: DEEP },
  CONTACTED: { description: "Contact search finished", className: VIOLET },
  EMAIL_READY: { description: "Email passed QC, waiting for your review", className: ATTENTION },
  APPROVED: { description: "You approved the email", className: DONE },
  SKIPPED: { description: "Deliberately excluded from outreach", className: MUTED },
  DUPLICATE: { description: "Same domain already in the database", className: MUTED },
  FAILED: { description: "A step failed; the next run retries it", className: BAD },
};

export const RUN_STATUS_META: Record<RunStatus, StatusMeta> = {
  PENDING: { description: "Created, not started yet", className: NEUTRAL },
  RUNNING: { description: "In progress right now", className: ACTIVE },
  COMPLETED: { description: "Finished, every step reported back", className: DONE },
  FAILED: { description: "Aborted by an error, or the process was killed", className: BAD },
  CANCELLED: { description: "Stopped on purpose", className: MUTED },
};

export const EMAIL_STATUS_META: Record<EmailStatus, StatusMeta> = {
  DRAFT: { description: "Generated, not checked yet", className: NEUTRAL },
  QC_FAILED: { description: "QC rejected it — see the reasons", className: BAD },
  READY: { description: "Passed QC, waiting for your review", className: ATTENTION },
  APPROVED: { description: "Approved for sending", className: DONE },
  SKIPPED: { description: "Will not be sent", className: MUTED },
};

export const SEVERITY_META: Record<IssueSeverity, StatusMeta> = {
  CRITICAL: { description: "Blocks buying — cart, checkout, page errors", className: BAD },
  MAJOR: { description: "Costs conversions but the store works", className: ATTENTION },
  MINOR: { description: "Worth mentioning, low impact", className: MUTED },
};

/** Falls back to neutral styling so an unknown value still renders. */
export function statusMeta<S extends string>(
  table: Record<S, StatusMeta>,
  status: string | null | undefined,
): StatusMeta {
  if (status && status in table) return table[status as S];
  return { description: "Unknown status", className: NEUTRAL };
}

/** Legend entries in pipeline order, so the list reads as the flow itself. */
export function legendEntries<S extends string>(
  table: Record<S, StatusMeta>,
): { status: S; description: string; className: string }[] {
  return (Object.keys(table) as S[]).map((status) => ({
    status,
    description: table[status].description,
    className: table[status].className,
  }));
}
