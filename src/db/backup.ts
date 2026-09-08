import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config/index.js';
import { getDb } from './client.js';

/**
 * Backups of the database and the screenshots (task 7-07).
 *
 * What is worth keeping is not the same in the two halves. The database is the
 * only place the audit findings, contacts and letters exist — everything else in
 * the project can be recomputed by running the pipeline again, and that costs
 * money and, for the storefronts, goodwill we have already spent. The
 * screenshots are large and reproducible, so they are copied only when asked.
 *
 * `VACUUM INTO` rather than a file copy: SQLite in WAL mode keeps recent writes
 * in a side file, so copying `database.sqlite` while anything is running yields
 * a file that is missing the newest rows or is torn outright. `VACUUM INTO` asks
 * SQLite for a consistent snapshot and is safe against a run in progress, which
 * is the moment somebody is most likely to want a backup.
 */

export interface BackupResult {
  database: string;
  databaseBytes: number;
  screenshots: string | null;
  screenshotFiles: number;
  /** Older backups removed by `keep`. */
  pruned: string[];
}

export interface BackupOptions {
  /** Where backups live. Defaults to `data/backups`. */
  dir?: string;
  /** Copy the screenshots too. They are large and can be regenerated. */
  screenshots?: boolean;
  /** How many timestamped backups to keep. 0 keeps everything. */
  keep?: number;
  now?: Date;
}

/**
 * `20260908T135104` — sortable as a plain string, and legal on every filesystem.
 *
 * The shape has to match what `listBackups` recognises, or pruning silently
 * keeps everything: it would find no directories to count, and never remove one.
 */
export function backupStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').slice(0, 15);
}

function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
    else total += 1;
  }
  return total;
}

/** Backup directories, newest last, for pruning. */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function createBackup(options: BackupOptions = {}): BackupResult {
  const config = getConfig();
  const root = options.dir ?? path.join(config.paths.data, 'backups');
  const stamp = backupStamp(options.now);
  const target = path.join(root, stamp);
  mkdirSync(target, { recursive: true });

  // A consistent snapshot even while a run is writing — see the note above.
  const dbFile = path.join(target, 'database.sqlite');
  getDb().prepare('VACUUM INTO ?').run(dbFile);

  let screenshots: string | null = null;
  let screenshotFiles = 0;
  if (options.screenshots && existsSync(config.paths.screenshots)) {
    screenshots = path.join(target, 'screenshots');
    cpSync(config.paths.screenshots, screenshots, { recursive: true });
    screenshotFiles = countFiles(screenshots);
  }

  const pruned: string[] = [];
  const keep = options.keep ?? 0;
  if (keep > 0) {
    const all = listBackups(root);
    for (const name of all.slice(0, Math.max(0, all.length - keep))) {
      rmSync(path.join(root, name), { recursive: true, force: true });
      pruned.push(name);
    }
  }

  return {
    database: dbFile,
    databaseBytes: statSync(dbFile).size,
    screenshots,
    screenshotFiles,
    pruned,
  };
}
