import { execute, queryAll, queryOne, type Database } from '../client.js';
import type { AuditIssueRow, AuditRow, IssuePage, ScreenshotRow } from '../types.js';
import { assertTransition, AUDIT_TRANSITIONS, type AuditStatus } from '../../pipeline/status.js';
import { nowIso } from '../../lib/time.js';

/** Persistence for the technical audit (tasks 2-04, 2-18). */

export function createAudit(storeId: number, runId: number | null, db?: Database): AuditRow {
  const { lastInsertRowid } = execute(
    'INSERT INTO audits (store_id, run_id, status) VALUES (?, ?, ?)',
    [storeId, runId, 'RUNNING'],
    db,
  );
  return getAudit(lastInsertRowid, db)!;
}

export function getAudit(id: number, db?: Database): AuditRow | undefined {
  return queryOne<AuditRow>('SELECT * FROM audits WHERE id = ?', [id], db);
}

export function getLatestAudit(storeId: number, db?: Database): AuditRow | undefined {
  return queryOne<AuditRow>(
    'SELECT * FROM audits WHERE store_id = ? ORDER BY id DESC LIMIT 1',
    [storeId],
    db,
  );
}

export interface ScreenshotInput {
  storeId: number;
  auditId: number | null;
  page: IssuePage;
  viewport: 'desktop' | 'mobile';
  /** Relative to SCREENSHOTS_DIR, so the database survives a move of the folder. */
  path: string;
  width?: number | null;
  height?: number | null;
}

export function saveScreenshot(input: ScreenshotInput, db?: Database): ScreenshotRow {
  const { lastInsertRowid } = execute(
    `INSERT INTO screenshots (store_id, audit_id, page, viewport, path, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.storeId,
      input.auditId,
      input.page,
      input.viewport,
      input.path,
      input.width ?? null,
      input.height ?? null,
      nowIso(),
    ],
    db,
  );
  return queryOne<ScreenshotRow>('SELECT * FROM screenshots WHERE id = ?', [lastInsertRowid], db)!;
}

export function listScreenshots(auditId: number, db?: Database): ScreenshotRow[] {
  return queryAll<ScreenshotRow>(
    'SELECT * FROM screenshots WHERE audit_id = ? ORDER BY id',
    [auditId],
    db,
  );
}

export interface AuditIssueInput {
  page: AuditIssueRow['page'];
  category: AuditIssueRow['category'];
  severity: AuditIssueRow['severity'];
  title: string;
  detail?: string | undefined;
  /** Serialised as `evidence_json`; an issue without evidence is allowed but rare. */
  evidence?: unknown;
  source?: string;
}

export function saveIssues(
  auditId: number,
  storeId: number,
  issues: readonly AuditIssueInput[],
  db?: Database,
): number {
  for (const issue of issues) {
    execute(
      `INSERT INTO audit_issues
         (audit_id, store_id, page, category, severity, title, detail, evidence_json, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        auditId,
        storeId,
        issue.page,
        issue.category,
        issue.severity,
        issue.title,
        issue.detail ?? null,
        issue.evidence === undefined ? null : JSON.stringify(issue.evidence),
        issue.source ?? 'playwright',
        nowIso(),
      ],
      db,
    );
  }
  return issues.length;
}

export function listIssues(auditId: number, db?: Database): AuditIssueRow[] {
  return queryAll<AuditIssueRow>(
    'SELECT * FROM audit_issues WHERE audit_id = ? ORDER BY id',
    [auditId],
    db,
  );
}

/** Wipes a previous attempt's findings so a re-run does not duplicate them (task 0-10). */
export function clearIssues(auditId: number, db?: Database): number {
  return execute('DELETE FROM audit_issues WHERE audit_id = ?', [auditId], db).changes;
}

export interface FinishAuditInput {
  status: AuditStatus;
  blocked?: boolean;
  /** Per-page facts, kept for the AI step in Epic 3. */
  pages?: unknown;
  seo?: unknown;
  error?: string | null;
}

export function finishAudit(id: number, input: FinishAuditInput, db?: Database): AuditRow {
  const audit = getAudit(id, db);
  if (!audit) throw new Error(`Audit ${id} not found`);
  assertTransition(AUDIT_TRANSITIONS, audit.status, input.status, 'audit');

  execute(
    `UPDATE audits
        SET status = ?, blocked = ?, pages_json = ?, seo_json = ?, error = ?, finished_at = ?
      WHERE id = ?`,
    [
      input.status,
      input.blocked ? 1 : 0,
      input.pages === undefined ? null : JSON.stringify(input.pages),
      input.seo === undefined ? null : JSON.stringify(input.seo),
      input.error ?? null,
      nowIso(),
      id,
    ],
    db,
  );
  return getAudit(id, db)!;
}
