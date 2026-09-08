"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { startPipeline, type ActionResult } from "@/lib/actions";
import type { LockInfo } from "@/lib/pipelineLock";
import { LIMIT_CHOICES } from "@/lib/runCommand";

interface RunControlsProps {
  /** The lock held by a run in progress, if any. */
  running: LockInfo | null;
}

export function RunControls({ running }: RunControlsProps) {
  const [state, submit, pending] = useActionState<ActionResult | null, FormData>(
    startPipeline,
    null,
  );
  const [limit, setLimit] = useState(10);
  const [refreshing, startRefresh] = useTransition();
  const router = useRouter();

  const busy = pending || running !== null;

  // A run writes to the database from another process, so the page has to ask
  // again to see progress. Poll only while something is actually running.
  useEffect(() => {
    if (running === null) return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [running, router]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <form action={submit} className="flex items-center gap-2">
          <input type="hidden" name="action" value="run" />
          <label htmlFor="limit" className="text-muted-foreground text-sm">
            Batch
          </label>
          <select
            id="limit"
            name="limit"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            disabled={busy}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm disabled:opacity-50"
          >
            {LIMIT_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={busy}>
            {busy ? "Running…" : "Fetch stores"}
          </Button>
        </form>

        <form action={submit}>
          <input type="hidden" name="action" value="seed" />
          <Button type="submit" variant="outline" disabled={busy}>
            Seed demo data
          </Button>
        </form>

        <Button
          type="button"
          variant="ghost"
          disabled={refreshing}
          onClick={() => startRefresh(() => router.refresh())}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {running !== null && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className="bg-foreground/60 inline-block size-2 animate-pulse rounded-full"
          />
          {running.label} in progress (pid {running.pid}) — refreshing every 2s.
        </p>
      )}

      {state && (
        <p
          role="status"
          className={`text-sm ${state.ok ? "text-muted-foreground" : "text-destructive"}`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
