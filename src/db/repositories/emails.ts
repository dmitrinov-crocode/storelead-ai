import { execute, queryAll, queryOne, transaction, type Database } from '../client.js';
import type { EmailRow } from '../types.js';
import type { EmailStatus } from '../../pipeline/status.js';
import {
  canTransition,
  EmailTransitionError,
  SUPERSEDABLE as SUPERSEDABLE_STATUSES,
} from '../../pipeline/emailTransitions.js';

export { EmailTransitionError } from '../../pipeline/emailTransitions.js';

/**
 * Storage and the status model for outreach drafts (task 5-08).
 *
 * Two rules shape this module, and both are about not losing evidence.
 *
 * **Every version is kept.** A rejected draft is the record of what the QC of
 * 5-04 refused and why, and the calibration pass of 5-09 reads exactly that —
 * twenty letters and the reasons they failed are worth more than twenty letters
 * that passed. `version` counts up per store and never reuses a number.
 *
 * **Only one version is live.** `DRAFT`, `QC_FAILED` and `READY` describe where
 * a draft is in the machine; `APPROVED` and `SKIPPED` are a human's decision and
 * are terminal. Superseding a draft moves the old row to `SKIPPED` rather than
 * deleting it, so the newest row is the only one a reviewer can act on.
 *
 *     DRAFT ──▶ QC_FAILED ──▶ (regenerated as a new version)
 *       │
 *       └────▶ READY ──▶ APPROVED
 *                   └──▶ SKIPPED
 *
 * Nothing here sends anything. The plan is explicit that outreach is drafted for
 * a human and dispatched by hand.
 */

/** Statuses a later version is allowed to supersede. */
const SUPERSEDABLE: ReadonlySet<EmailStatus> = new Set(SUPERSEDABLE_STATUSES);

export interface SaveEmailInput {
  storeId: number;
  runId: number | null;
  /** The person it is addressed to, when one was found. */
  contactId?: number | null;
  subject: string;
  body: string;
  /** Counted by the caller, which is also what 5-05 checks. */
  wordCount?: number | null;
  /** The lead category the letter was written for (task 5-02). */
  category?: string | null;
  /** Prompt version and hash, so a batch can be compared across runs (3-10). */
  promptVersion?: string | null;
  status?: EmailStatus;
  /** The QC verdict, as the agent of 5-04 returned it. */
  qc?: unknown;
  qcPassed?: boolean | null;
  /** Highest similarity against an earlier letter (task 5-07). */
  similarity?: number | null;
}

export function listEmails(storeId: number, db?: Database): EmailRow[] {
  return queryAll<EmailRow>(
    'SELECT * FROM emails WHERE store_id = ? ORDER BY version DESC',
    [storeId],
    db,
  );
}

/** The newest version, whatever state it is in. */
export function getLatestEmail(storeId: number, db?: Database): EmailRow | undefined {
  return queryOne<EmailRow>(
    'SELECT * FROM emails WHERE store_id = ? ORDER BY version DESC LIMIT 1',
    [storeId],
    db,
  );
}

/**
 * Letters already written, newest first.
 *
 * Used by the repetition detector of 5-07, which has to compare a new draft
 * against what has already been written — including rejected drafts, since a
 * letter that repeats a refused one is no better than one that repeats a sent
 * one. The subject travels with the body: two letters carrying the same subject
 * line word for word is the template tell a merchant notices first.
 */
export function listEarlierLetters(
  options: { excludeStoreId?: number; limit?: number } = {},
  db?: Database,
): EarlierLetterRow[] {
  const limit = options.limit ?? 500;
  if (options.excludeStoreId !== undefined) {
    return queryAll<EarlierLetterRow>(
      'SELECT id, store_id, subject, body FROM emails WHERE store_id <> ? ORDER BY id DESC LIMIT ?',
      [options.excludeStoreId, limit],
      db,
    );
  }
  return queryAll<EarlierLetterRow>(
    'SELECT id, store_id, subject, body FROM emails ORDER BY id DESC LIMIT ?',
    [limit],
    db,
  );
}

export interface EarlierLetterRow {
  id: number;
  store_id: number;
  /** Compared alongside the body: two identical subjects are a template tell. */
  subject: string;
  body: string;
}

/**
 * Writes a new version and retires the one it replaces.
 *
 * The read of the previous version and both writes are one transaction: two runs
 * racing on the same store would otherwise both claim the same `version`, and
 * the unique index would fail the second one after the first had already
 * superseded a row.
 */
export function saveEmail(input: SaveEmailInput, db?: Database): EmailRow {
  const run = (): EmailRow => {
    const previous = queryOne<EmailRow>(
      'SELECT * FROM emails WHERE store_id = ? ORDER BY version DESC LIMIT 1',
      [input.storeId],
      db,
    );

    // A human's decision is final: a new draft never overwrites it, it just
    // becomes the newer version and leaves the old verdict standing.
    if (previous && SUPERSEDABLE.has(previous.status)) {
      execute('UPDATE emails SET status = ? WHERE id = ?', ['SKIPPED', previous.id], db);
    }

    const version = (previous?.version ?? 0) + 1;
    const { lastInsertRowid } = execute(
      `INSERT INTO emails
         (store_id, contact_id, run_id, version, subject, body, word_count,
          category, prompt_version, status, qc_json, qc_passed, similarity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.storeId,
        input.contactId ?? null,
        input.runId,
        version,
        input.subject,
        input.body,
        input.wordCount ?? null,
        input.category ?? null,
        input.promptVersion ?? null,
        input.status ?? 'DRAFT',
        input.qc === undefined ? null : JSON.stringify(input.qc),
        input.qcPassed === undefined || input.qcPassed === null ? null : input.qcPassed ? 1 : 0,
        input.similarity ?? null,
      ],
      db,
    );

    return queryOne<EmailRow>('SELECT * FROM emails WHERE id = ?', [Number(lastInsertRowid)], db)!;
  };

  return transaction(run, db);
}

/**
 * Records a human's decision on one draft (the buttons of task 6-08).
 *
 * Guarded rather than a bare UPDATE: approving a letter that never passed QC is
 * the one mistake in this flow that puts an unchecked claim in front of a
 * merchant, and a dashboard button is exactly where that misclick happens.
 */
export function setEmailStatus(
  emailId: number,
  status: 'APPROVED' | 'SKIPPED',
  db?: Database,
): EmailRow {
  const run = (): EmailRow => {
    const row = queryOne<EmailRow>('SELECT * FROM emails WHERE id = ?', [emailId], db);
    if (!row) throw new Error(`email ${emailId} not found`);

    if (!canTransition(row.status, status)) throw new EmailTransitionError(row.status, status);

    execute('UPDATE emails SET status = ? WHERE id = ?', [status, emailId], db);
    return { ...row, status };
  };

  return transaction(run, db);
}

/** Counts by status across every store — the run report of 7-04 reads this. */
export function countEmailsByStatus(db?: Database): Record<string, number> {
  const rows = queryAll<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM emails GROUP BY status',
    [],
    db,
  );
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}
