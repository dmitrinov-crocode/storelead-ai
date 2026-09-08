import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Reader for the pipeline lock. The writer lives in `src/lib/pipelineLock.ts`
 * (the dashboard cannot import from there); the JSON shape is the contract.
 *
 * The database's RUNNING row cannot answer "is a run in progress?" on its own:
 * a run killed with SIGKILL leaves its row RUNNING forever, which wedged this
 * UI shut during testing. Process liveness is the reliable signal, and it also
 * closes the startup race where two quick clicks both see an idle database.
 *
 * The dashboard also writes a lock for the CLI it spawns, so the guard holds
 * during the second before the child process claims the lock itself.
 */

export interface LockInfo {
  pid: number;
  startedAt: string;
  label: string;
}

/** A run that has somehow outlived this is treated as abandoned. */
export const MAX_LOCK_AGE_MS = 60 * 60 * 1000;

export function lockPath(dataDir: string): string {
  return path.join(dataDir, "pipeline.lock");
}

export function writeLock(dataDir: string, info: LockInfo): void {
  writeFileSync(lockPath(dataDir), JSON.stringify(info), "utf-8");
}

export function readLock(dataDir: string): LockInfo | null {
  const file = lockPath(dataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<LockInfo>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt, label: parsed.label ?? "pipeline" };
  } catch {
    // A truncated or hand-edited lock must not wedge the UI shut.
    return null;
  }
}

export function clearLock(dataDir: string): void {
  rmSync(lockPath(dataDir), { force: true });
}

/** Signal 0 tests for existence without touching the process. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockCheckDeps {
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

/** Returns the holding lock, or null when none is held or it is stale. */
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
