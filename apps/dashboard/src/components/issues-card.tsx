import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { SEVERITY_META } from "@/lib/status-meta";
import type { IssueRow } from "@/lib/queries";

/**
 * The audit findings, grouped and with their evidence (task 6-05).
 *
 * Grouped by severity first and page second, because that is the order a person
 * triages in: what is broken, then where. Every finding opens to the evidence
 * the check recorded — the selector, the URL, what was expected against what
 * happened — since a claim in a letter is only as good as the row behind it, and
 * this is where somebody verifies one before approving.
 *
 * Rendered with `<details>` rather than React state: it is a disclosure widget,
 * the browser has one, and this page is a server component everywhere else.
 */

const SEVERITY_ORDER = ["CRITICAL", "MAJOR", "MINOR"] as const;

/**
 * Playwright writes its failures with ANSI colour codes, which arrive in
 * `detail` verbatim and render as `[2m` litter in a browser.
 */
const ANSI = /\u001b\[[0-9;]*m/g;

function clean(text: string): string {
  return text.replace(ANSI, "").trim();
}

/** One evidence object, whose keys differ per check, as label/value lines. */
function Evidence({ json }: { json: string | null }) {
  let entries: Record<string, unknown>[];
  try {
    const parsed: unknown = json ? JSON.parse(json) : [];
    entries = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {entries.map((entry, index) => (
        <dl key={index} className="bg-muted/40 space-y-1 rounded-md p-2 text-xs">
          {Object.entries(entry).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="text-muted-foreground w-24 shrink-0">{key}</dt>
              <dd className="min-w-0 break-words">
                {key === "url" && typeof value === "string" ? (
                  <a
                    href={value}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    {value}
                  </a>
                ) : (
                  <code>{typeof value === "string" ? clean(value) : JSON.stringify(value)}</code>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}

export function IssuesCard({ issues }: { issues: IssueRow[] }) {
  const groups = SEVERITY_ORDER.map((severity) => ({
    severity,
    rows: issues.filter((issue) => issue.severity === severity),
  })).filter((group) => group.rows.length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Issues
          <span className="text-muted-foreground text-sm font-normal">
            {issues.length === 0 ? "none found" : `${issues.length} in the latest audit`}
          </span>
          {groups.map((group) => (
            <StatusBadge key={group.severity} status={group.severity} table={SEVERITY_META} />
          ))}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {issues.length === 0 && (
          <p className="text-muted-foreground text-sm">
            The audit either found nothing or has not run for this shop.
          </p>
        )}

        {groups.map((group) => (
          <section key={group.severity}>
            <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
              {group.severity.toLowerCase()} — {group.rows.length}
            </h3>
            <ul className="space-y-2">
              {group.rows.map((issue) => (
                <li key={issue.id}>
                  <details className="rounded-md border">
                    <summary className="cursor-pointer list-none px-3 py-2 text-sm">
                      <span className="font-medium">{issue.title}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {issue.page} · {issue.category}
                      </span>
                    </summary>
                    <div className="border-t px-3 py-2">
                      {issue.detail && (
                        <p className="text-muted-foreground text-sm whitespace-pre-wrap">
                          {clean(issue.detail)}
                        </p>
                      )}
                      <Evidence json={issue.evidence_json} />
                      <p className="text-muted-foreground mt-2 text-xs">
                        finding #{issue.id} · from {issue.source}
                      </p>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
