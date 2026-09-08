import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Single-writer lock for pipeline runs.
 *
 * Written by whoever starts a run — the CLI, whether invoked from a terminal or
 * spawned by the dashboard — so "is a run in progress?" is answered by process
 * liveness rather than by a database row. A row cannot answer it: a killed run
 * leaves its row RUNNING forever, which is exactly how the dashboard wedged shut
 * during testing.
 *
 * The dashboard has its own reader for this file (it cannot import from src/);
 * the JSON shape below is the contract between them.
 */

export interface LockInfo {
  pid: number;
  startedAt: string;
  label: string;
}

export const MAX_LOCK_AGE_MS = 60 * 60 * 1000;

export function lockPath(dataDir: string): string {
  return path.join(dataDir, 'pipeline.lock');
}

export function writeLock(dataDir: string, info: LockInfo): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(lockPath(dataDir), JSON.stringify(info), 'utf-8');
}

export function readLock(dataDir: string): LockInfo | null {
  const file = lockPath(dataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt, label: parsed.label ?? 'pipeline' };
  } catch {
    return null;
  }
}

export function clearLock(dataDir: string): void {
  rmSync(lockPath(dataDir), { force: true });
}

/** Signal 0 tests for existence without touching the process. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockCheckDeps {
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

/** The holding lock, or null when none is held or the holder is gone. */
export function activeLock(dataDir: string, deps: LockCheckDeps = {}): LockInfo | null {
  const lock = readLock(dataDir);
  if (!lock) return null;

  const isAlive = deps.isAlive ?? processAlive;
  const now = deps.now ?? Date.now;

  if (!isAlive(lock.pid)) return null;
  const age = now() - Date.parse(lock.startedAt);
  if (!Number.isFinite(age) || age > MAX_LOCK_AGE_MS) return null;
  return lock;
}
