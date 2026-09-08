import { execute, queryAll, queryOne, type Database } from '../client.js';
import type { AiAnalysisRow } from '../types.js';

/**
 * Results of the AI agents (Epic 3).
 *
 * Rows are appended, never updated: a re-run of the same store adds a row rather
 * than overwriting one. Comparing two readings of the same shop across prompt
 * versions is the whole point of storing `prompt_version` (task 3-10), and an
 * overwrite would delete the thing being compared. Readers take the newest row
 * per agent — which is what the dashboard's join does too.
 */

export interface AiAnalysisInput {
  storeId: number;
  runId: number | null;
  agent: AiAnalysisRow['agent'];
  promptVersion: string;
  /** The prompt as it was sent, so a result can be reproduced. */
  input?: string | null;
  output?: string | null;
  category?: string | null;
  leadScore?: number | null;
  priority?: string | null;
  reason?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs?: number | null;
  /** 'OK' | 'AI_FAILED' | 'SKIPPED'. */
  status?: string;
  error?: string | null;
}

export function saveAiAnalysis(input: AiAnalysisInput, db?: Database): AiAnalysisRow {
  const { lastInsertRowid } = execute(
    `INSERT INTO ai_analyses
       (store_id, run_id, agent, prompt_version, input_json, output_json,
        category, lead_score, priority, reason, tokens_in, tokens_out,
        duration_ms, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.storeId,
      input.runId,
      input.agent,
      input.promptVersion,
      input.input ?? null,
      input.output ?? null,
      input.category ?? null,
      input.leadScore ?? null,
      input.priority ?? null,
      input.reason ?? null,
      input.tokensIn ?? null,
      input.tokensOut ?? null,
      input.durationMs ?? null,
      input.status ?? 'OK',
      input.error ?? null,
    ],
    db,
  );
  return queryOne<AiAnalysisRow>('SELECT * FROM ai_analyses WHERE id = ?', [lastInsertRowid], db)!;
}

export function getLatestAnalysis(
  storeId: number,
  agent: AiAnalysisRow['agent'],
  db?: Database,
): AiAnalysisRow | undefined {
  return queryOne<AiAnalysisRow>(
    'SELECT * FROM ai_analyses WHERE store_id = ? AND agent = ? ORDER BY id DESC LIMIT 1',
    [storeId, agent],
    db,
  );
}

export function listAnalyses(storeId: number, db?: Database): AiAnalysisRow[] {
  return queryAll<AiAnalysisRow>(
    'SELECT * FROM ai_analyses WHERE store_id = ? ORDER BY id',
    [storeId],
    db,
  );
}
