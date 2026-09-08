import { execute, queryAll, queryOne, transaction, type Database } from '../client.js';
import type { ContactRow, ContactSuppressionRow } from '../types.js';
import type { ContactCandidate } from '../../contacts/ranking.js';
import { normalizeDomain } from '../../lib/domain.js';
import { nowIso } from '../../lib/time.js';

/**
 * Persistence and deduplication for contacts (task 4-10).
 *
 * Two kinds of duplicate are handled here, and they are not the same problem.
 * Inside one store the same address is simply one contact, whatever page it came
 * from. Across stores a repeated address means something else: an agency, a
 * platform mailbox or a franchise head office. Those are still worth keeping —
 * they are a real way to reach the shop — but writing "hi Anna" to a mailbox
 * shared by five storefronts is exactly the outreach the QC of 5-04 exists to
 * prevent, so their confidence is cut and the sharing is recorded.
 */

export type SuppressionReason = 'erasure_request' | 'objection' | 'manual';

/** Above this many stores an address is a shared mailbox, not this shop's contact. */
const SHARED_ACROSS_STORES = 3;
/** What a shared address keeps of its score. */
const SHARED_PENALTY = 0.5;

export function listContacts(storeId: number, db?: Database): ContactRow[] {
  return queryAll<ContactRow>(
    `SELECT * FROM contacts WHERE store_id = ?
     ORDER BY is_primary DESC, is_generic ASC, confidence DESC, id ASC`,
    [storeId],
    db,
  );
}

export function getPrimaryContact(storeId: number, db?: Database): ContactRow | undefined {
  return queryOne<ContactRow>(
    'SELECT * FROM contacts WHERE store_id = ? AND is_primary = 1 LIMIT 1',
    [storeId],
    db,
  );
}

/** How many other stores already list this address. */
export function countStoresWithEmail(email: string, storeId: number, db?: Database): number {
  const row = queryOne<{ n: number }>(
    'SELECT COUNT(DISTINCT store_id) AS n FROM contacts WHERE email = ? AND store_id <> ?',
    [email, storeId],
    db,
  );
  return row?.n ?? 0;
}

export interface SaveContactsResult {
  written: number;
  /** Candidates dropped as duplicates of a row already written in this batch. */
  duplicates: number;
  /** Addresses demoted for appearing on other stores too. */
  shared: number;
  /** Candidates refused because the person or the shop asked to be forgotten. */
  suppressed: number;
}

/* ----------------------------------------------------------------- GDPR (4-11) */

/**
 * Records that a person or a shop must not be contacted, and deletes what is
 * already held about them.
 *
 * Erasure and suppression are one operation on purpose. Deleting the rows alone
 * would be undone by the next run, which reads the same page and writes the same
 * address back; suppressing without deleting would leave the data in the
 * database. Doing either half on its own is the bug this function exists to
 * prevent, so it is the only supported way to honour a request.
 */
export function forgetEmail(
  email: string,
  reason: SuppressionReason = 'erasure_request',
  db?: Database,
): { deleted: number } {
  const address = email.trim().toLowerCase();
  const run = () => {
    execute(
      // The unique index is partial, so the conflict target must repeat its WHERE.
      `INSERT INTO contact_suppressions (email, reason) VALUES (?, ?)
       ON CONFLICT (email) WHERE email IS NOT NULL DO NOTHING`,
      [address, reason],
      db,
    );
    const { changes } = execute('DELETE FROM contacts WHERE LOWER(email) = ?', [address], db);
    return { deleted: changes };
  };
  return db ? run() : transaction(run);
}

/** The same, for every contact of one storefront. */
export function forgetDomain(
  domain: string,
  reason: SuppressionReason = 'erasure_request',
  db?: Database,
): { deleted: number } {
  const normalized = normalizeDomain(domain)?.domain ?? domain.trim().toLowerCase();
  const run = () => {
    execute(
      `INSERT INTO contact_suppressions (domain, reason) VALUES (?, ?)
       ON CONFLICT (domain) WHERE domain IS NOT NULL DO NOTHING`,
      [normalized, reason],
      db,
    );
    const { changes } = execute(
      `DELETE FROM contacts
        WHERE store_id IN (SELECT id FROM stores WHERE domain = ?)
           OR LOWER(SUBSTR(email, INSTR(email, '@') + 1)) = ?`,
      [normalized, normalized],
      db,
    );
    return { deleted: changes };
  };
  return db ? run() : transaction(run);
}

export function listSuppressions(db?: Database): ContactSuppressionRow[] {
  return queryAll<ContactSuppressionRow>(
    'SELECT * FROM contact_suppressions ORDER BY id DESC',
    [],
    db,
  );
}

/** Undoes a suppression. The contacts themselves are not restored — they are gone. */
export function unsuppress(identifier: string, db?: Database): { removed: number } {
  const value = identifier.trim().toLowerCase();
  const { changes } = execute(
    'DELETE FROM contact_suppressions WHERE email = ? OR domain = ?',
    [value, value],
    db,
  );
  return { removed: changes };
}

/** Address or its domain named on the suppression list. */
export function isSuppressed(email: string | null, storeDomain: string, db?: Database): boolean {
  const domain = normalizeDomain(storeDomain)?.domain ?? storeDomain.trim().toLowerCase();
  const address = email?.trim().toLowerCase() ?? null;
  const mailDomain = address?.slice(address.indexOf('@') + 1) ?? null;

  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM contact_suppressions
      WHERE (email IS NOT NULL AND email = ?)
         OR (domain IS NOT NULL AND domain IN (?, ?))`,
    [address, domain, mailDomain],
    db,
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Deletes contacts older than the retention period (see `CONTACT_RETENTION_DAYS`).
 *
 * Storage limitation is a GDPR principle, not a nicety: a lead we never wrote to
 * has no purpose left once it is stale, and keeping it needs a justification we
 * do not have. Runs from the CLI so the period is applied deliberately rather
 * than silently in the middle of a pipeline run.
 */
export function purgeExpiredContacts(retentionDays: number, db?: Database): { deleted: number } {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const { changes } = execute('DELETE FROM contacts WHERE created_at < ?', [cutoff], db);
  return { deleted: changes };
}

/* ----------------------------------------------------------------- writing */

/**
 * Replaces a store's contacts with the ranked candidates.
 *
 * Replace, not merge: the candidates are recomputed from the shop's pages every
 * time, so a merge would keep addresses the shop has since removed and could
 * leave `is_primary` on two rows. The first non-generic row that survives
 * becomes the primary — the dashboard and the outreach agent both need exactly
 * one designated address, and choosing it here keeps that decision beside the
 * ranking that produced the order.
 */
export function saveContacts(
  storeId: number,
  candidates: readonly ContactCandidate[],
  db?: Database,
): SaveContactsResult {
  const result: SaveContactsResult = { written: 0, duplicates: 0, shared: 0, suppressed: 0 };
  const seenEmails = new Set<string>();
  const seenNames = new Set<string>();
  let primaryId: number | null = null;

  const run = (): SaveContactsResult => {
    execute('DELETE FROM contacts WHERE store_id = ?', [storeId], db);

    // The suppression check lives here rather than in the step, so no future
    // caller can write a contact without passing it (task 4-11).
    const domain =
      queryOne<{ domain: string }>('SELECT domain FROM stores WHERE id = ?', [storeId], db)
        ?.domain ?? '';
    if (isSuppressed(null, domain, db)) {
      result.suppressed = candidates.length;
      return result;
    }

    for (const candidate of candidates) {
      // A row that is neither an address, nor a name, nor a profile is nothing.
      if (candidate.email === null && candidate.name === null && candidate.linkedinUrl === null) {
        continue;
      }

      if (candidate.email !== null && isSuppressed(candidate.email, domain, db)) {
        result.suppressed += 1;
        continue;
      }

      // Within one store an address is one contact, whichever page named it.
      if (candidate.email !== null) {
        if (seenEmails.has(candidate.email)) {
          result.duplicates += 1;
          continue;
        }
        seenEmails.add(candidate.email);
      } else if (candidate.name !== null) {
        const key = candidate.name.toLowerCase();
        if (seenNames.has(key)) {
          result.duplicates += 1;
          continue;
        }
        seenNames.add(key);
      }

      let confidence = candidate.confidence;
      if (candidate.email !== null) {
        const elsewhere = countStoresWithEmail(candidate.email, storeId, db);
        if (elsewhere >= SHARED_ACROSS_STORES) {
          confidence = Math.round(confidence * SHARED_PENALTY * 100) / 100;
          result.shared += 1;
        }
      }

      const isPrimary = primaryId === null && !candidate.isGeneric ? 1 : 0;

      const { lastInsertRowid } = execute(
        `INSERT INTO contacts
           (store_id, name, role, email, linkedin_url, source, source_url,
            confidence, is_generic, is_primary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          storeId,
          candidate.name,
          candidate.role,
          candidate.email,
          candidate.linkedinUrl,
          candidate.source,
          candidate.sourceUrl,
          confidence,
          candidate.isGeneric ? 1 : 0,
          isPrimary,
          nowIso(),
        ],
        db,
      );
      if (isPrimary === 1) primaryId = lastInsertRowid;
      result.written += 1;
    }

    // Nothing but shared mailboxes: one of them still has to be the primary,
    // or the store looks contactless to 5-03.
    if (primaryId === null && result.written > 0) {
      execute(
        `UPDATE contacts SET is_primary = 1
         WHERE id = (SELECT id FROM contacts WHERE store_id = ?
                     ORDER BY confidence DESC, id ASC LIMIT 1)`,
        [storeId],
        db,
      );
    }

    return result;
  };

  return db ? run() : transaction(run);
}
