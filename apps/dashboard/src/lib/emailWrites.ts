import { DatabaseSync } from "node:sqlite";
import {
  canTransition,
  EmailTransitionError,
  type HumanDecision,
} from "@core/pipeline/emailTransitions";

/**
 * The dashboard's only write path (task 6-08).
 *
 * Everything else here reads through a read-only handle, and that stays true:
 * this module opens its own writable connection, uses it for two UPDATE
 * statements, and does nothing else. It cannot reach the pipeline's repositories
 * because Turbopack cannot resolve their `.js` specifiers onto `.ts` files —
 * which is why the transition rule was moved to an import-free module that both
 * writers share. The rule exists once; only the connection differs.
 */

const DB_PATH = process.env.STORELEAD_DB_PATH;

let handle: DatabaseSync | undefined;

function writable(): DatabaseSync {
  if (!DB_PATH) {
    throw new Error(
      "STORELEAD_DB_PATH is not set — it is injected by next.config.ts from the pipeline config.",
    );
  }
  if (!handle) {
    handle = new DatabaseSync(DB_PATH);
    // A run may be writing at the same moment; wait rather than fail the click.
    handle.exec("PRAGMA busy_timeout = 5000");
    handle.exec("PRAGMA foreign_keys = ON");
  }
  return handle;
}

export interface DecidedEmail {
  id: number;
  storeId: number;
  status: HumanDecision;
}

/**
 * Records a human's decision on one draft, refusing the moves the machine does
 * not allow — approving a letter QC never passed, above all.
 */
export function decide(emailId: number, decision: HumanDecision): DecidedEmail {
  const db = writable();
  const row = db.prepare("SELECT id, store_id, status FROM emails WHERE id = ?").get(emailId) as
    | { id: number; store_id: number; status: string }
    | undefined;

  if (!row) throw new Error(`No draft with id ${emailId}.`);
  if (!canTransition(row.status as never, decision)) {
    throw new EmailTransitionError(row.status, decision);
  }

  db.prepare("UPDATE emails SET status = ? WHERE id = ?").run(decision, emailId);
  return { id: row.id, storeId: row.store_id, status: decision };
}
