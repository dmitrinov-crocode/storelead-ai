/** ISO-8601 UTC with milliseconds — the single timestamp format used in the database. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
