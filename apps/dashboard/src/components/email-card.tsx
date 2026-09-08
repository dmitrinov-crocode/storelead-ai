"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { EMAIL_STATUS_META } from "@/lib/status-meta";
import { decideEmail, regenerateEmail, type ActionResult } from "@/lib/actions";
import type { StoreEmailRow } from "@/lib/queries";
import type { LockInfo } from "@/lib/pipelineLock";

/**
 * The letter, its QC verdict and the three decisions (task 6-08).
 *
 * The verdict is shown item by item rather than as one pass/fail, because that
 * is what a reviewer actually needs: a letter refused on tone is a rewrite, one
 * refused on facts is a bug in the pipeline, and the summary hides which.
 *
 * Approve is only offered on a draft that reached READY. That is enforced again
 * in `setEmailStatus`, and the button is hidden here for the same reason — the
 * one mistake in this flow that puts an unchecked claim in front of a merchant
 * is approving a letter QC never passed, and a disabled-looking button people
 * try anyway is worse than no button.
 */

interface QcCheck {
  name: string;
  verdict: string;
  reason: string;
}

function parseChecks(json: string | null): QcCheck[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as QcCheck[]) : [];
  } catch {
    return [];
  }
}

const VERDICT_TONE: Record<string, string> = {
  PASS: "text-emerald-700",
  FAIL: "text-red-700",
  NOT_CHECKED: "text-muted-foreground",
};

interface EmailCardProps {
  emails: StoreEmailRow[];
  storeId: number;
  domain: string;
  runId: number | null;
  running: LockInfo | null;
}

export function EmailCard({ emails, storeId, domain, runId, running }: EmailCardProps) {
  const [decision, decide, deciding] = useActionState<ActionResult | null, FormData>(
    decideEmail,
    null,
  );
  const [rewrite, startRewrite, rewriting] = useActionState<ActionResult | null, FormData>(
    regenerateEmail,
    null,
  );
  const [showing, setShowing] = useState(0);
  const [copied, setCopied] = useState(false);
  const [, startRefresh] = useTransition();
  const router = useRouter();

  // A rewrite runs in another process; the page has to ask again to see it.
  useEffect(() => {
    if (running === null) return;
    const timer = setInterval(() => startRefresh(() => router.refresh()), 2000);
    return () => clearInterval(timer);
  }, [running, router]);

  if (emails.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Letter</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No letter has been written for this shop yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  const email = emails[Math.min(showing, emails.length - 1)]!;
  const checks = parseChecks(email.qc_json);
  const busy = deciding || rewriting || running !== null;
  const decided = email.status === "APPROVED" || email.status === "SKIPPED";
  const message = decision ?? rewrite;

  const copy = () => {
    void navigator.clipboard.writeText(`${email.subject}\n\n${email.body}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Letter
          <StatusBadge status={email.status} table={EMAIL_STATUS_META} />
          <span className="text-muted-foreground text-sm font-normal">
            v{email.version} · {email.word_count ?? "?"} words
            {email.similarity !== null && ` · ${Math.round(email.similarity * 100)}% like an earlier one`}
          </span>
          {emails.length > 1 && (
            <select
              value={showing}
              onChange={(event) => setShowing(Number(event.target.value))}
              className="border-input bg-background ml-auto h-8 rounded-md border px-2 text-sm"
              aria-label="Version"
            >
              {emails.map((row, index) => (
                <option key={row.id} value={index}>
                  v{row.version} — {row.status.toLowerCase()}
                </option>
              ))}
            </select>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-md border">
          <div className="border-b px-3 py-2 text-sm font-medium">{email.subject}</div>
          <p className="px-3 py-3 text-sm leading-relaxed whitespace-pre-wrap">{email.body}</p>
        </div>

        {checks.length > 0 && (
          <div>
            <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
              QC
            </h3>
            <ul className="space-y-1 text-sm">
              {checks.map((check) => (
                <li key={check.name} className="flex gap-2">
                  <span className="w-32 shrink-0 capitalize">{check.name}</span>
                  <span className={`w-24 shrink-0 font-medium ${VERDICT_TONE[check.verdict] ?? ""}`}>
                    {check.verdict.replace(/_/g, " ").toLowerCase()}
                  </span>
                  <span className="text-muted-foreground">{check.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {email.status === "READY" && (
            <form action={decide}>
              <input type="hidden" name="emailId" value={email.id} />
              <input type="hidden" name="decision" value="APPROVED" />
              <Button type="submit" disabled={busy}>
                Approve
              </Button>
            </form>
          )}

          {!decided && (
            <form action={decide}>
              <input type="hidden" name="emailId" value={email.id} />
              <input type="hidden" name="decision" value="SKIPPED" />
              <Button type="submit" variant="outline" disabled={busy}>
                Skip
              </Button>
            </form>
          )}

          <form action={startRewrite}>
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="domain" value={domain} />
            <input type="hidden" name="runId" value={runId ?? ""} />
            <Button type="submit" variant="outline" disabled={busy || runId === null}>
              {running ? "Working…" : "Regenerate"}
            </Button>
          </form>

          <Button type="button" variant="ghost" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>

        {message && (
          <p className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>
            {message.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
